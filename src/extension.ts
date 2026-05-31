import * as vscode from "vscode";
import { ChatProvider } from "./provider/ChatProvider";
import { BackendClient } from "./services/BackendClient";
import { StreamHandler } from "./StreamHandler";
import { Logger } from "./utils/Logger";

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger("AI Workspace Bridge");
  logger.info("Extension activating");

  try {
    const backendClient = new BackendClient(context, logger);
    const streamHandler = new StreamHandler(logger);
    const provider = new ChatProvider(backendClient, streamHandler, logger);

    const disposable = vscode.lm.registerLanguageModelChatProvider(
      "ai-workspace-bridge",
      provider
    );

    const participant = vscode.chat.createChatParticipant(
      "ai-workspace-bridge.myagent",
      async (request, _context, response, token) => {
        try {
          const prompt = request.prompt.trim();
          logger.info(`Chat participant prompt received: ${prompt}`);

          const tokenStream = backendClient.sendPrompt(prompt, token);
          await streamHandler.streamChatTokens(tokenStream, response, token);
        } catch (error) {
          logger.error("Chat participant failed", error);
        }
      }
    );

    const setTokenCommand = vscode.commands.registerCommand("ai-workspace-bridge.setToken", async () => {
      await backendClient.setToken();
    });

    const clearTokenCommand = vscode.commands.registerCommand("ai-workspace-bridge.clearToken", async () => {
      await backendClient.clearToken();
    });

    const resetBrowserProfileCommand = vscode.commands.registerCommand("ai-workspace-bridge.resetBrowserProfile", async () => {
      await backendClient.resetBrowserProfile();
    });

    const openBrowserCommand = vscode.commands.registerCommand("ai-workspace-bridge.openBrowser", async () => {
      await backendClient.openBrowserForLogin();
    });

    const statusCommand = vscode.commands.registerCommand("ai-workspace-bridge.status", () => {
      const message = backendClient.getStatus();

      if (backendClient.canAttemptChatGPT()) {
        vscode.window.showInformationMessage(message);
      } else {
        vscode.window.showWarningMessage(message);
      }
    });

    context.subscriptions.push(
      disposable,
      participant,
      setTokenCommand,
      clearTokenCommand,
      resetBrowserProfileCommand,
      openBrowserCommand,
      statusCommand,
      backendClient,
      logger
    );
    logger.info("Model provider registered");
  } catch (error) {
    logger.error("Activation failed", error);
  }
}

export function deactivate(): void {
  // No-op: resources are disposed via subscriptions.
}
