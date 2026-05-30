import * as vscode from "vscode";
import { IBackendClient } from "../types/ChatTypes";
import { Logger } from "../utils/Logger";
import { ChatGPTClient } from "./ChatGPTClient";

export class BackendClient implements IBackendClient, vscode.Disposable {
  private readonly chatGPTClient: ChatGPTClient;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.chatGPTClient = new ChatGPTClient(context, logger);
    this.chatGPTClient.initialize().catch((error) => {
      this.logger.error("Failed to initialize ChatGPT", error);
    });
  }

  public async *sendPrompt(prompt: string, token: vscode.CancellationToken): AsyncIterable<string> {
    this.logger.info("Backend request started");

    const response = await this.getResponse(prompt, token);
    const tokens = this.tokenize(response);

    for (const chunk of tokens) {
      if (token.isCancellationRequested) {
        this.logger.info("Backend request cancelled");
        break;
      }

      yield chunk;
    }

    this.logger.info("Backend request finished");
  }

  public async setToken(): Promise<void> {
    await this.chatGPTClient.promptForToken();
  }

  public async clearToken(): Promise<void> {
    await this.chatGPTClient.clearToken();
  }

  public hasToken(): boolean {
    return this.chatGPTClient.hasToken();
  }

  public getStatus(): string {
    const status = this.chatGPTClient.getStatus();

    if (!status.hasToken) {
      return "No ChatGPT token configured. Run 'AI Workspace Bridge: Set ChatGPT Token' to enable real responses.";
    }

    return status.isBrowserReady
      ? "ChatGPT token configured and browser is ready."
      : "ChatGPT token configured, but the browser is not ready yet.";
  }

  public async dispose(): Promise<void> {
    await this.chatGPTClient.dispose();
  }

  private async getResponse(prompt: string, token: vscode.CancellationToken): Promise<string> {
    if (!this.chatGPTClient.hasToken()) {
      return this.getMockResponse(prompt);
    }

    try {
      return await this.chatGPTClient.askQuestion(prompt, token);
    } catch (error) {
      this.logger.error("Falling back to mock response", error);
      return this.getMockResponse(prompt);
    }
  }

  private getMockResponse(prompt: string): string {
    const normalized = prompt.trim().toLowerCase();

    if (normalized.startsWith("hell")) {
      return "Hello from Workspace Agent. To use real ChatGPT responses, run 'AI Workspace Bridge: Set ChatGPT Token'.";
    }

    if (normalized.includes("fastapi")) {
      return "FastAPI is a modern Python framework for building APIs. Set your ChatGPT token for real AI responses.";
    }

    if (normalized.includes("sqlalchemy")) {
      return "SQLAlchemy provides ORM and database abstraction for Python. Set your ChatGPT token for real AI responses.";
    }

    const firstToken = normalized.split(/\s+/)[0] || "";
    const questionWords = ["what", "how", "why", "when", "where", "who", "can", "should"];
    if (normalized.endsWith("?") || questionWords.includes(firstToken)) {
      return "I am in mock mode. Set your ChatGPT token to enable real responses.";
    }

    return `You asked: ${prompt}\n\nTo enable real ChatGPT, run 'AI Workspace Bridge: Set ChatGPT Token' from the command palette.`;
  }

  private tokenize(text: string): string[] {
    const words = text.split(/\s+/).filter(Boolean);

    return words.map((word, index) => {
      const isLast = index === words.length - 1;
      return isLast ? word : `${word} `;
    });
  }
}
