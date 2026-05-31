import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import puppeteer, { Browser, Page } from "puppeteer";
import { CHATGPT_TOKEN_SECRET_KEY, ChatGPTClientStatus, ChatGPTSelectors } from "../types/ChatGPTTypes";
import { Logger } from "../utils/Logger";

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
  private readonly userDataDir: string;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.userDataDir = path.join(context.globalStorageUri.fsPath, "chatgpt-browser-profile");
  }

  public async initialize(): Promise<void> {
    this.token = await this.context.secrets.get(CHATGPT_TOKEN_SECRET_KEY) ?? null;

    if (!this.token) {
      const profileStatus = this.hasBrowserProfile() ? "existing browser profile found" : "no browser profile found";
      this.logger.info(`No ChatGPT token configured; ${profileStatus}`);
      return;
    }

    this.logger.info("ChatGPT token found; browser will open on first prompt");
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

    this.token = token.trim();
    await this.context.secrets.store(CHATGPT_TOKEN_SECRET_KEY, this.token);
    await this.initBrowser();
    vscode.window.showInformationMessage("ChatGPT token saved. Use the browser window to finish any login or verification.");
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
    await this.page?.bringToFront();
    vscode.window.showInformationMessage("ChatGPT browser opened. Log in there, then send @myagent another prompt.");
  }

  public async askQuestion(prompt: string, token: vscode.CancellationToken): Promise<string> {
    if (!this.browser || !this.page) {
      await this.initBrowser();
    }

    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    if (token.isCancellationRequested) {
      return "";
    }

    try {
      await this.ensurePromptReady();

      const messageCount = await this.getAssistantMessageCount();
      await this.enterPrompt(prompt);
      await this.waitForResponse(messageCount, token);

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

      this.browser = await this.launchVisibleBrowser();

      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(45000);
      if (this.token) {
        await this.applySessionCookie();
      }
      await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await this.page.bringToFront();
      this.logger.info(`ChatGPT browser initialized at ${this.page.url()}`);
    } finally {
      this.isInitializing = false;
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
        "--start-maximized"
      ]
    };

    try {
      const browser = await puppeteer.launch({
        ...launchOptions,
        channel: "chrome"
      });
      this.logger.info("Launched system Chrome for ChatGPT browser");
      return browser;
    } catch (error) {
      this.logger.error("System Chrome launch failed; falling back to bundled Chromium", error);
      return puppeteer.launch(launchOptions);
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }

    this.browser = null;
    this.page = null;
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

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.page.waitForSelector(DEFAULT_SELECTORS.promptInput, { timeout: 15000 });
        return;
      } catch {
        await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
        await this.page.bringToFront();
      }
    }

    const title = await this.page.title();
    const url = this.page.url();
    const bodyPreview = await this.page.evaluate(() => document.body.innerText.slice(0, 300));
    this.logger.error(`ChatGPT prompt was not found. Page title="${title}", url="${url}", body="${bodyPreview}"`);
    throw new Error("ChatGPT prompt input was not found.");
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
    await this.page.waitForSelector(selector, { timeout: 15000 });
    await this.page.focus(selector);
    await this.clearPromptInput();
    await this.typePromptAsSingleMessage(prompt);
    await this.page.keyboard.press("Enter");
    await this.clickSendIfPromptStillHasText();
  }

  private async clearPromptInput(): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("A");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.press("Backspace");
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

    await new Promise((resolve) => setTimeout(resolve, 500));

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

  private async extractLatestResponse(): Promise<string> {
    if (!this.page) {
      return "";
    }

    return this.page.$$eval(DEFAULT_SELECTORS.assistantMessage, (messages) => {
      const lastMessage = messages[messages.length - 1];
      return lastMessage?.textContent?.trim() ?? "";
    });
  }
}
