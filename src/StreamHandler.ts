import * as vscode from "vscode";
import { IStreamHandler } from "./types/ChatTypes";
import { Logger } from "./utils/Logger";

const TOKEN_DELAY_MS = 50;

export class StreamHandler implements IStreamHandler {
  public constructor(private readonly logger: Logger) {}

  public async streamTokens(
    tokens: AsyncIterable<string>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.logger.info("Stream started");

    try {
      for await (const chunk of tokens) {
        if (token.isCancellationRequested) {
          this.logger.info("Stream cancelled");
          break;
        }

        progress.report(new vscode.LanguageModelTextPart(chunk));
        await this.delay(TOKEN_DELAY_MS);
      }
    } catch (error) {
      this.logger.error("Stream failed", error);
    } finally {
      this.logger.info("Stream finished");
    }
  }

  public async streamChatTokens(
    tokens: AsyncIterable<string>,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.logger.info("Chat stream started");

    try {
      for await (const chunk of tokens) {
        if (token.isCancellationRequested) {
          this.logger.info("Chat stream cancelled");
          break;
        }
        // Log each chunk so we can confirm the exact text being streamed
        this.logger.info(`Chat token: ${chunk}`);
        response.markdown(chunk);
        await this.delay(TOKEN_DELAY_MS);
      }
    } catch (error) {
      this.logger.error("Chat stream failed", error);
    } finally {
      this.logger.info("Chat stream finished");
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
