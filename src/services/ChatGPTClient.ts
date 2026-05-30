import * as vscode from "vscode";
import puppeteer, { Browser, Page } from "puppeteer";
import { CHATGPT_TOKEN_SECRET_KEY, ChatGPTClientStatus, ChatGPTSelectors } from "../types/ChatGPTTypes";
import { Logger } from "../utils/Logger";

const CHATGPT_URL = "https://chat.openai.com";
const DEFAULT_SELECTORS: ChatGPTSelectors = {
  promptInput: "#prompt-textarea, textarea[placeholder*='Send'], textarea[placeholder*='Message']",
  assistantMessage: "[data-message-author-role='assistant']",
  stopGeneratingButton: "button[aria-label*='Stop'], button[data-testid='stop-button']"
};

export class ChatGPTClient implements vscode.Disposable {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private token: string | null = null;
  private isInitializing = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  public async initialize(): Promise<void> {
    this.token = await this.context.secrets.get(CHATGPT_TOKEN_SECRET_KEY) ?? null;

    if (!this.token) {
      this.logger.info("No ChatGPT token configured; using mock responses");
      return;
    }

    await this.initBrowser();
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
    vscode.window.showInformationMessage("ChatGPT token saved.");
  }

  public async clearToken(): Promise<void> {
    this.token = null;
    await this.context.secrets.delete(CHATGPT_TOKEN_SECRET_KEY);
    await this.closeBrowser();
    vscode.window.showInformationMessage("ChatGPT token cleared.");
  }

  public hasToken(): boolean {
    return !!this.token;
  }

  public getStatus(): ChatGPTClientStatus {
    return {
      hasToken: this.hasToken(),
      isBrowserReady: !!this.browser && !!this.page
    };
  }

  public async askQuestion(prompt: string, token: vscode.CancellationToken): Promise<string> {
    if (!this.token) {
      throw new Error("ChatGPT token is not configured.");
    }

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
      throw new Error("Failed to get a ChatGPT response. The token may be expired.");
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

      this.browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      });

      this.page = await this.browser.newPage();
      await this.applySessionCookie();
      await this.page.goto(CHATGPT_URL, { waitUntil: "networkidle2", timeout: 30000 });
      this.logger.info("ChatGPT browser initialized");
    } finally {
      this.isInitializing = false;
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

    await this.page.setCookie({
      name: "__Secure-next-auth.session-token.0",
      value: this.token,
      domain: ".chat.openai.com",
      path: "/",
      secure: true,
      httpOnly: true
    });
  }

  private async ensurePromptReady(): Promise<void> {
    if (!this.page) {
      throw new Error("ChatGPT browser page is not available.");
    }

    try {
      await this.page.waitForSelector(DEFAULT_SELECTORS.promptInput, { timeout: 10000 });
    } catch {
      await this.applySessionCookie();
      await this.page.goto(CHATGPT_URL, { waitUntil: "networkidle2", timeout: 30000 });
      await this.page.waitForSelector(DEFAULT_SELECTORS.promptInput, { timeout: 15000 });
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

    await this.page.focus(DEFAULT_SELECTORS.promptInput);
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("A");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.type(prompt);
    await this.page.keyboard.press("Enter");
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
