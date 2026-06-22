import * as vscode from "vscode";

export interface WorkspaceChatModel extends vscode.LanguageModelChatInformation {}

export interface IBackendClient {
  sendPrompt(prompt: string, token: vscode.CancellationToken): AsyncIterable<string>;
}

export interface IStreamHandler {
  streamTokens(
    tokens: AsyncIterable<string>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void>;

  streamChatTokens(
    tokens: AsyncIterable<string>,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void>;
}

export interface IChatProvider {
  provideResponse(
    model: WorkspaceChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void>;
}
