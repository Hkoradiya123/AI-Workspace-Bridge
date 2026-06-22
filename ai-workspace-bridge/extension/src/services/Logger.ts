import * as vscode from "vscode";

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  public constructor(channelName: string) {
    this.channel = vscode.window.createOutputChannel(channelName);
  }

  public info(message: string): void {
    this.channel.appendLine(`[INFO] ${message}`);
  }

  public warn(message: string): void {
    this.channel.appendLine(`[WARN] ${message}`);
  }

  public error(message: string, error?: unknown): void {
    const suffix = error instanceof Error ? `: ${error.message}` : "";
    this.channel.appendLine(`[ERROR] ${message}${suffix}`);
  }

  public dispose(): void {
    this.channel.dispose();
  }
}
