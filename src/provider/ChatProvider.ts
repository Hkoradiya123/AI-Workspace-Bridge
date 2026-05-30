import * as vscode from "vscode";
import { IBackendClient, IChatProvider, IStreamHandler, WorkspaceChatModel } from "../types/ChatTypes";
import { Logger } from "../utils/Logger";

export class ChatProvider implements vscode.LanguageModelChatProvider<WorkspaceChatModel>, IChatProvider {
  private readonly models: WorkspaceChatModel[] = [
    {
      id: "workspace-agent",
      name: "Workspace Agent",
      family: "workspace",
      version: "1.0.0",
      maxInputTokens: 8000,
      maxOutputTokens: 1000,
      capabilities: {
        imageInput: false,
        toolCalling: false
      }
    }
  ];

  public constructor(
    private readonly backendClient: IBackendClient,
    private readonly streamHandler: IStreamHandler,
    private readonly logger: Logger
  ) {}

  public provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<WorkspaceChatModel[]> {
    return this.models;
  }

  public async provideLanguageModelChatResponse(
    model: WorkspaceChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.provideResponse(model, messages, options, progress, token);
  }

  public async provideResponse(
    _model: WorkspaceChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    try {
      const prompt = this.extractLatestUserPrompt(messages);
      this.logger.info(`Prompt received: ${prompt}`);

      const tokenStream = this.backendClient.sendPrompt(prompt, token);
      await this.streamHandler.streamTokens(tokenStream, progress, token);
    } catch (error) {
      this.logger.error("Chat response failed", error);
    }
  }

  public async provideTokenCount(
    _model: WorkspaceChatModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const value = typeof text === "string" ? text : this.extractTextFromMessage(text);
    return value.length;
  }

  private extractLatestUserPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const userMessages = messages.filter((message) => message.role === vscode.LanguageModelChatMessageRole.User);
    const last = userMessages[userMessages.length - 1];

    if (!last) {
      return "";
    }

    return this.extractTextFromMessage(last).trim();
  }

  private extractTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
    const parts = message.content;
    let text = "";

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }

    return text;
  }
}
