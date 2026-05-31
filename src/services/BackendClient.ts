import * as vscode from "vscode";
import { IBackendClient } from "../types/ChatTypes";
import { Logger } from "../utils/Logger";
import { ChatGPTClient } from "./ChatGPTClient";
import { WorkspaceAgent, WorkspaceToolCall } from "./WorkspaceAgent";

const MAX_CHATGPT_TOOL_ROUNDS = 3;

export class BackendClient implements IBackendClient, vscode.Disposable {
  private readonly chatGPTClient: ChatGPTClient;
  private readonly workspaceAgent: WorkspaceAgent;
  private sentChatGPTToolContext = false;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.chatGPTClient = new ChatGPTClient(context, logger);
    this.workspaceAgent = new WorkspaceAgent(logger);
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

  public async resetBrowserProfile(): Promise<void> {
    await this.chatGPTClient.resetBrowserProfile();
  }

  public async openBrowserForLogin(): Promise<void> {
    await this.chatGPTClient.openBrowserForLogin();
  }

  public hasToken(): boolean {
    return this.chatGPTClient.hasToken();
  }

  public canAttemptChatGPT(): boolean {
    return this.chatGPTClient.canAttemptChatGPT();
  }

  public getStatus(): string {
    const status = this.chatGPTClient.getStatus();

    if (!status.hasToken && !this.chatGPTClient.hasBrowserProfile()) {
      return "No ChatGPT token or browser login profile found. Run 'AI Workspace Bridge: Open ChatGPT Browser' and log in.";
    }

    if (status.isBrowserReady) {
      return "ChatGPT browser is ready. If the visible browser is logged in, real responses should work.";
    }

    return "ChatGPT auth data exists. The browser will open on the next prompt.";
  }

  public async dispose(): Promise<void> {
    await this.chatGPTClient.dispose();
  }

  private async getResponse(prompt: string, token: vscode.CancellationToken): Promise<string> {
    if (this.chatGPTClient.canAttemptChatGPT()) {
      try {
        return await this.askChatGPTWithTools(prompt, token);
      } catch (error) {
        this.logger.error("ChatGPT failed; trying local workspace agent", error);
      }
    }

    const agentResponse = await this.workspaceAgent.tryHandle(prompt, token);

    if (agentResponse.handled) {
      return agentResponse.response;
    }

    return this.getMockResponse(prompt);
  }

  private async askChatGPTWithTools(prompt: string, token: vscode.CancellationToken): Promise<string> {
    const cleanPrompt = this.cleanUserPrompt(prompt);

    if (this.isSystemPromptCommand(cleanPrompt)) {
      return this.resendSystemPrompt(token);
    }

    let modelPrompt = this.buildModelPrompt(cleanPrompt);

    for (let round = 0; round < MAX_CHATGPT_TOOL_ROUNDS; round += 1) {
      const response = await this.chatGPTClient.askQuestion(modelPrompt, token);
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        if (this.containsToolCall(response)) {
          return "ChatGPT tried to request a VS Code tool, but the TOOL_CALL JSON was invalid. Ask it to retry using valid one-line JSON. For multi-line file content, it should use `contentBase64`.";
        }

        if (this.needsWorkspaceMutation(cleanPrompt, response)) {
          modelPrompt = this.buildMissingToolCorrectionPrompt(cleanPrompt, response);
          continue;
        }

        return response;
      }

      this.logger.info(`ChatGPT requested tool: ${toolCall.tool}`);
      const toolResult = await this.workspaceAgent.executeToolCall(toolCall, token);
      modelPrompt = this.buildToolResultPrompt(cleanPrompt, toolCall, toolResult);
    }

    return "ChatGPT requested too many tool rounds. Try asking for a smaller task.";
  }

  private buildModelPrompt(userPrompt: string): string {
    if (this.sentChatGPTToolContext) {
      return userPrompt;
    }

    this.sentChatGPTToolContext = true;
    return this.buildInitialSystemPrompt(userPrompt);
  }

  private buildInitialSystemPrompt(userPrompt: string): string {
    return [
        "SYSTEM MESSAGE FOR THIS VS CODE AGENT SESSION",
        "You are the reasoning brain for a VS Code extension called AI Workspace Bridge.",
        "You cannot directly read files or run VS Code APIs from ChatGPT.",
        "The extension can execute tools for you if you request them with the exact protocol below.",
        this.workspaceAgent.getToolManifestForModel(),
      "",
      "User request:",
      userPrompt,
      "",
      "If you can answer without workspace access, answer normally.",
      "If you need workspace access, reply only with valid one-line TOOL_CALL JSON.",
      "For writeFile with code or multi-line text, use contentBase64."
    ].join("\n");
  }

  private cleanUserPrompt(prompt: string): string {
    return prompt.replace(/^@myagent\b\s*/i, "").trim();
  }

  private isSystemPromptCommand(prompt: string): boolean {
    return /^\/?sysprompt\b/i.test(prompt) || /^\/?system\s*prompt\b/i.test(prompt);
  }

  private async resendSystemPrompt(token: vscode.CancellationToken): Promise<string> {
    this.sentChatGPTToolContext = true;
    const prompt = this.buildInitialSystemPrompt(
      "Acknowledge this setup in one short sentence. Do not call tools yet."
    );
    const response = await this.chatGPTClient.askQuestion(prompt, token);
    return `Re-sent the ChatGPT tool/system prompt.\n\nChatGPT replied: ${response}`;
  }

  private buildToolResultPrompt(originalPrompt: string, toolCall: WorkspaceToolCall, toolResult: string): string {
    return [
      "TOOL_RESULT",
      `Tool: ${toolCall.tool}`,
      "Result:",
      toolResult,
      "",
      "Original user request:",
      originalPrompt,
      "",
      "Now answer the user using the tool result. If you need another tool, reply only with another TOOL_CALL JSON."
    ].join("\n");
  }

  private buildMissingToolCorrectionPrompt(originalPrompt: string, previousResponse: string): string {
    return [
      "Your previous response claimed or implied that a workspace change was done, but no VS Code tool was called.",
      "You cannot create, edit, or update files unless you request a tool.",
      "",
      "Previous response:",
      previousResponse,
      "",
      "Original user request:",
      originalPrompt,
      "",
      "If the user wants a file created or changed, reply only with a valid one-line TOOL_CALL.",
      "Use writeFile with contentBase64 for multi-line code.",
      "Example:",
      "TOOL_CALL {\"tool\":\"writeFile\",\"args\":{\"filePath\":\"example.py\",\"contentBase64\":\"<base64 utf8>\"}}"
    ].join("\n");
  }

  private parseToolCall(response: string): WorkspaceToolCall | null {
    const cleaned = response
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();
    const match = cleaned.match(/TOOL_CALL\s*(\{[\s\S]*\})/i);

    if (!match) {
      return null;
    }

    try {
      const parsed = JSON.parse(match[1]) as WorkspaceToolCall;

      if (!parsed.tool || typeof parsed.tool !== "string") {
        return null;
      }

      return parsed;
    } catch (error) {
      this.logger.error("Failed to parse ChatGPT tool call", error);
      return null;
    }
  }

  private containsToolCall(response: string): boolean {
    return /TOOL_CALL/i.test(response);
  }

  private needsWorkspaceMutation(prompt: string, response: string): boolean {
    const actionPrompt = /\b(build|built|create|make|implement|add|write|fix|update|modify|change)\b/i.test(prompt);
    const claimsMutation = /\b(created|wrote|updated|modified|changed|added|implemented|built)\b/i.test(response);

    return actionPrompt || claimsMutation;
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
