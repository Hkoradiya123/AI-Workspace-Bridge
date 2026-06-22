import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import puppeteer, { Browser, Page } from "puppeteer";
import { CHATGPT_TOKEN_SECRET_KEY, ChatGPTClientStatus, ChatGPTSelectors } from "../types/ChatGPTTypes";
import { Logger } from "./Logger";

// Import stealth plugin to hide browser automation from CloudFlare detection
let StealthPlugin: any;
try {
  StealthPlugin = require("puppeteer-extra-plugin-stealth");
} catch {
  // Stealth plugin is optional; if not installed, continue without it
  StealthPlugin = null;
}

const CHATGPT_URL = "https://chatgpt.com";
const CHATGPT_COOKIE_DOMAINS = [".chatgpt.com", ".chat.openai.com"];
const CHATGPT_COOKIE_NAMES = ["__Secure-next-auth.session-token", "__Secure-next-auth.session-token.0"];
const DEFAULT_SELECTORS: ChatGPTSelectors = {
  promptInput: "#prompt-textarea, div[contenteditable='true'][data-testid='prompt-textarea'], textarea[placeholder*='Send'], textarea[placeholder*='Message']",
  assistantMessage: "[data-message-author-role='assistant']",
  stopGeneratingButton: "button[aria-label*='Stop'], button[data-testid='stop-button']",
  sendButton: "button[data-testid='send-button'], button[aria-label*='Send']"
};

export class ChatGPTClient implements vscode.Disposable {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private token: string | null = null;
  private isInitializing = false;
  private sessionEpoch = 0;
  private readonly userDataDir: string;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.userDataDir = path.join(context.globalStorageUri.fsPath, "chatgpt-browser-profile");
  }

  public async initialize(): Promise<void> {
    this.token = await this.context.secrets.get(CHATGPT_TOKEN_SECRET_KEY) ?? null;

    if (!this.token && !this.hasBrowserProfile()) {
      const profileStatus = this.hasBrowserProfile() ? "existing browser profile found" : "no browser profile found";
      this.logger.info(`No ChatGPT token configured; ${profileStatus}`);
      return;
    }

    this.logger.info("ChatGPT auth/profile found; auto-starting browser on extension startup.");
    try {
      await this.initBrowser();
    } catch (error) {
      this.logger.error("Auto-start browser failed during initialize()", error);
    }
  }

  public async promptForToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      prompt: "Paste your ChatGPT session token from browser cookies",
      placeHolder: "eyJhbGciOiJSUzI1NiIsImtpZCI6...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length < 20) {
          return "Paste a valid session token.";
        }

        return null;
      }
    });

    if (!token) {
      return;
    }

    await this.setToken(token);
    vscode.window.showInformationMessage("ChatGPT token saved. Use the browser window to finish any login or verification.");
  }

  public async setToken(token: string): Promise<void> {
    this.token = token.trim();
    await this.context.secrets.store(CHATGPT_TOKEN_SECRET_KEY, this.token);
    await this.initBrowser();
  }

  public async clearToken(): Promise<void> {
    this.token = null;
    await this.context.secrets.delete(CHATGPT_TOKEN_SECRET_KEY);
    vscode.window.showInformationMessage("ChatGPT token cleared. The browser login profile was kept.");
  }

  public async resetBrowserProfile(): Promise<void> {
    await this.closeBrowser();

    if (fs.existsSync(this.userDataDir)) {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    }

    vscode.window.showInformationMessage("ChatGPT browser profile reset. Open the ChatGPT browser and log in again.");
  }

  public hasToken(): boolean {
    return !!this.token;
  }

  public hasBrowserProfile(): boolean {
    return fs.existsSync(this.userDataDir);
  }

  public canAttemptChatGPT(): boolean {
    return this.hasToken() || this.hasBrowserProfile() || (!!this.browser && !!this.page);
  }

  public getStatus(): ChatGPTClientStatus {
    return {
      hasToken: this.hasToken(),
      isBrowserReady: !!this.browser && !!this.page
    };
  }

  public async openBrowserForLogin(): Promise<void> {
    await this.initBrowser();
    await this.closeStaleTabs(this.page);
    await this.page?.bringToFront();
    vscode.window.showInformationMessage("ChatGPT browser opened. Log in there, then send @myagent another prompt.");
  }

  public getSessionEpoch(): number {
    return this.sessionEpoch;
  }

  public async ensureBrowserReady(): Promise<boolean> {
    const previousEpoch = this.sessionEpoch;
    const needsReinit = !this.browser || !this.page || !this.browser.isConnected() || this.page.isClosed();

    if (needsReinit) {
      await this.initBrowser();
    }

    return this.sessionEpoch !== previousEpoch;
  }

  public async askQuestion(prompt: string, token: vscode.CancellationToken): Promise<string> {
    return this.askQuestionWithStreaming(prompt, token);
  }

  public async askQuestionWithStreaming(
    prompt: string,
    token: vscode.CancellationToken,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    await this.ensureBrowserReady();

    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    if (token.isCancellationRequested) {
      return "";
    }

    try {
      await this.closeStaleTabs(this.page);
      await this.ensurePromptReady();

      const messageCount = await this.getAssistantMessageCount();
      await this.enterPrompt(prompt);
      if (onChunk) {
        await this.waitForResponseStreaming(messageCount, token, onChunk);
      } else {
        await this.waitForResponse(messageCount, token);
      }

      const response = await this.extractLatestResponse();
      return response || "No response received from ChatGPT.";
    } catch (error) {
      this.logger.error("ChatGPT request failed", error);
      throw new Error("Failed to get a ChatGPT response. The token may be expired or ChatGPT may be waiting for manual verification.");
    }
  }

  public async dispose(): Promise<void> {
    await this.closeBrowser();
  }

  private async initBrowser(): Promise<void> {
    if (this.isInitializing) {
      return;
    }

    this.isInitializing = true;

    try {
      await this.closeBrowser();
      fs.mkdirSync(this.userDataDir, { recursive: true });

      // Retry loop for CloudFlare challenges
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          this.browser = await this.launchVisibleBrowser();
          this.page = await this.browser.newPage();
          this.page.setDefaultTimeout(30000);
          this.page.setDefaultNavigationTimeout(45000);
          
          await this.page.setRequestInterception(true);
          this.page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });
          
          if (this.token) {
            await this.applySessionCookie();
          }
          
          await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

          await this.closeStaleTabs(this.page);
          
          // Check for CloudFlare challenge
          if (await this.isCloudFlareChallenge()) {
            this.logger.warn(`CloudFlare challenge detected on attempt ${attempt}. User must manually verify.`);
            await this.page.bringToFront();
            vscode.window.showWarningMessage(
              "CloudFlare Challenge Detected",
              "Your browser shows a security challenge. Please verify it manually in the browser window, then close this dialog.",
              "OK"
            );
            
            // Wait 15 seconds for user to complete challenge
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            if (attempt < 3) {
              continue;
            }
          }
          
          await this.page.bringToFront();
          this.logger.info(`ChatGPT browser initialized at ${this.page.url()}`);
          this.sessionEpoch += 1;
          return;
        } catch (error) {
          this.logger.warn(`Browser initialization attempt ${attempt} failed: ${error}`);
          await this.closeBrowser();
          
          if (attempt < 3) {
            // Exponential backoff before retry
            const delayMs = 2000 * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }
      
      throw new Error("Failed to initialize ChatGPT browser after 3 attempts. CloudFlare may be blocking automation.");
    } finally {
      this.isInitializing = false;
    }
  }

  private async isCloudFlareChallenge(): Promise<boolean> {
    if (!this.page) return false;

    try {
      const content = await this.page.content();
      const bodyText = await this.page.evaluate(() => document.body.innerText);
      
      // Check for CloudFlare indicators
      return content.includes("Unusual activity") || 
             content.includes("challenge") ||
             content.includes("57b477e7") ||
             bodyText.includes("Unusual activity") ||
             bodyText.includes("verify you are human");
    } catch {
      return false;
    }
  }

  private async launchVisibleBrowser(): Promise<Browser> {
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: false,
      defaultViewport: null,
      userDataDir: this.userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        "--disable-web-resources",
        "--disable-extensions",
        "--disable-gpu",
        "--blink-settings=imagesEnabled=false"
      ]
    };

    // Use stealth plugin if available to hide automation from CloudFlare
    let browser: Browser;
    if (StealthPlugin) {
      const puppeteerExtra = require("puppeteer-extra");
      puppeteerExtra.use(StealthPlugin());
      browser = await puppeteerExtra.launch(launchOptions);
      this.logger.info("Browser launched with stealth plugin enabled");
    } else {
      browser = await puppeteer.launch(launchOptions);
      this.logger.warn("Stealth plugin not available - CloudFlare may block automation. Install puppeteer-extra-plugin-stealth.");
    }

    return browser;
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }

    this.browser = null;
    this.page = null;
  }

  private async closeStaleTabs(keepPage?: Page | null): Promise<void> {
    if (!this.browser) {
      return;
    }

    const pages = await this.browser.pages().catch(() => []);

    await Promise.all(
      pages.map(async (page) => {
        if (keepPage && page === keepPage) {
          return;
        }

        const url = page.url();
        if (url === "about:blank" || url.startsWith(CHATGPT_URL) || url.includes("chatgpt")) {
          await page.close({ runBeforeUnload: true }).catch(() => undefined);
        }
      })
    );
  }

  private async applySessionCookie(): Promise<void> {
    if (!this.page || !this.token) {
      return;
    }

    const cookies = CHATGPT_COOKIE_DOMAINS.flatMap((domain) => {
      return CHATGPT_COOKIE_NAMES.map((name) => ({
        name,
        value: this.token!,
        domain,
        path: "/",
        secure: true,
        httpOnly: true
      }));
    });

    await this.page.setCookie(...cookies);
  }

  private async ensurePromptReady(): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    await this.page.bringToFront();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        // Check for CloudFlare challenge
        if (await this.isCloudFlareChallenge()) {
          throw new Error("CloudFlare challenge detected");
        }
        
        await this.page.waitForSelector(DEFAULT_SELECTORS.promptInput, { timeout: 10000 });
        // Reduced delay: only wait a tiny bit to avoid being flagged, not seconds.
        await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
        return;
      } catch (error) {
        if (attempt === 3) {
          const title = await this.page.title();
          const url = this.page.url();
          const bodyPreview = await this.page.evaluate(() => document.body.innerText.slice(0, 300));
          this.logger.error(`ChatGPT prompt was not found. Page title="${title}", url="${url}", body="${bodyPreview}"`);
          throw new Error("ChatGPT prompt input was not found. CloudFlare challenge may be blocking.");
        }
        
        // Reload page and retry
        await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.page.bringToFront();
        // Reduced backoff
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  private async getAssistantMessageCount(): Promise<number> {
    if (!this.page) {
      return 0;
    }

    return this.page.$$eval(DEFAULT_SELECTORS.assistantMessage, (messages) => messages.length);
  }

  private async enterPrompt(prompt: string): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    const selector = DEFAULT_SELECTORS.promptInput;
    await this.page.waitForSelector(selector, { timeout: 10000 });
    await this.page.focus(selector);
    // Faster human-like delay
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    await this.clearPromptInput();
    await this.typePromptAsSingleMessage(prompt);
    // Minimal delay before sending
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    await this.page.keyboard.press("Enter");
    await this.clickSendIfPromptStillHasText();
  }

  private async clearPromptInput(): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    // Faster clear: only run if there's actually text
    const hasText = await this.page.$eval(DEFAULT_SELECTORS.promptInput, (element) => {
      if ("value" in element) return !!(element as HTMLTextAreaElement).value.trim();
      return !!element.textContent?.trim();
    }).catch(() => false);

    if (hasText) {
      await this.page.keyboard.down("Control");
      await this.page.keyboard.press("A");
      await this.page.keyboard.up("Control");
      await this.page.keyboard.press("Backspace");
    }
  }

  private async typePromptAsSingleMessage(prompt: string): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    const client = await this.page.target().createCDPSession();
    await client.send("Input.insertText", { text: prompt });
  }

  private async clickSendIfPromptStillHasText(): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    // Reduced delay
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stillHasText = await this.page.$eval(DEFAULT_SELECTORS.promptInput, (element) => {
      if ("value" in element) {
        return !!(element as HTMLTextAreaElement).value.trim();
      }

      return !!element.textContent?.trim();
    }).catch(() => false);

    if (stillHasText) {
      await this.page.click(DEFAULT_SELECTORS.sendButton).catch(() => undefined);
    }
  }

  private async waitForResponse(previousMessageCount: number, token: vscode.CancellationToken): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    await this.page.waitForFunction(
      (assistantSelector, stopSelector, previousCount) => {
        const assistantMessages = document.querySelectorAll(assistantSelector);
        const stopButton = document.querySelector(stopSelector);
        return assistantMessages.length > previousCount && !stopButton;
      },
      {
        timeout: 120000,
        polling: 500
      },
      DEFAULT_SELECTORS.assistantMessage,
      DEFAULT_SELECTORS.stopGeneratingButton,
      previousMessageCount
    );

    if (token.isCancellationRequested) {
      throw new Error("ChatGPT request cancelled.");
    }
  }

  private async waitForResponseStreaming(
    previousMessageCount: number,
    token: vscode.CancellationToken,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    const timeoutAt = Date.now() + 120000;
    let lastText = "";

    while (true) {
      if (token.isCancellationRequested) {
        throw new Error("ChatGPT request cancelled.");
      }

      const snapshot = await this.page.evaluate((assistantSelector, stopSelector) => {
        const assistantMessages = Array.from(document.querySelectorAll(assistantSelector));
        const lastMessage = assistantMessages[assistantMessages.length - 1] as HTMLElement | undefined;
        let latestText = "";
        
        if (lastMessage) {
          const clone = lastMessage.cloneNode(true) as HTMLElement;
          // Remove math duplication
          clone.querySelectorAll('.katex-mathml').forEach(el => el.remove());
          
          // Format code blocks
          clone.querySelectorAll('pre').forEach(pre => {
            const code = pre.querySelector('code');
            const langMatch = code?.className.match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : '';
            const text = pre.innerText || pre.textContent || '';
            const wrapper = document.createElement('div');
            wrapper.innerText = `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
            if (pre.parentNode) pre.parentNode.replaceChild(wrapper, pre);
          });
          
          // Format inline code
          clone.querySelectorAll('code:not(pre code)').forEach(code => {
            const wrapper = document.createElement('span');
            wrapper.innerText = `\`${code.textContent}\``;
            if (code.parentNode) code.parentNode.replaceChild(wrapper, code);
          });
          
          latestText = clone.innerText?.trim() ?? "";
        }
        
        const stopButton = document.querySelector(stopSelector);
        return {
          assistantCount: assistantMessages.length,
          latestText,
          stopVisible: !!stopButton
        };
      }, DEFAULT_SELECTORS.assistantMessage, DEFAULT_SELECTORS.stopGeneratingButton);

      if (snapshot.assistantCount > previousMessageCount) {
        const nextText = snapshot.latestText.trimEnd();
        if (nextText && nextText !== lastText) {
          if (nextText.startsWith(lastText)) {
            const delta = nextText.slice(lastText.length);
            if (delta) {
              onChunk(delta);
            }
          } else {
            // Fallback if the page rewrites partial content while generating.
            onChunk(`\n${nextText}`);
          }
          lastText = nextText;
        }

        if (!snapshot.stopVisible && nextText.length > 0) {
          return;
        }
      }

      if (Date.now() > timeoutAt) {
        throw new Error("Timed out waiting for ChatGPT response.");
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  private async extractLatestResponse(): Promise<string> {
    if (!this.page) {
      return "";
    }

    return this.page.$$eval(DEFAULT_SELECTORS.assistantMessage, (messages) => {
      const lastMessage = messages[messages.length - 1] as HTMLElement;
      if (!lastMessage) {
        return "";
      }

      const clone = lastMessage.cloneNode(true) as HTMLElement;
      
      // Remove math duplication
      clone.querySelectorAll('.katex-mathml').forEach(el => el.remove());
      
      // Format code blocks
      clone.querySelectorAll('pre').forEach(pre => {
        const code = pre.querySelector('code');
        const langMatch = code?.className.match(/language-(\w+)/);
        const lang = langMatch ? langMatch[1] : '';
        const text = pre.innerText || pre.textContent || '';
        const wrapper = document.createElement('div');
        wrapper.innerText = `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
        if (pre.parentNode) pre.parentNode.replaceChild(wrapper, pre);
      });
      
      // Format inline code
      clone.querySelectorAll('code:not(pre code)').forEach(code => {
        const wrapper = document.createElement('span');
        wrapper.innerText = `\`${code.textContent}\``;
        if (code.parentNode) code.parentNode.replaceChild(wrapper, code);
      });

      return clone.innerText?.trim() ?? "";
    });
  }
}
