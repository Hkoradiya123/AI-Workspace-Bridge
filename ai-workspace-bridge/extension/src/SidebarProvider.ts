import * as vscode from 'vscode';
import { WorkspaceAgent } from './services/WorkspaceAgent';
import { Logger } from './services/Logger';
import { AIClient } from './services/AIClient';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiwb.sidebarView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceAgent: WorkspaceAgent,
    private readonly aiClient: AIClient,
    private readonly logger: Logger
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'gui', 'dist')]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendPrompt': {
          try {
            this.sendToWebview({ type: 'streamStart' });
            const tokenSource = new vscode.CancellationTokenSource();
            
            let userPrompt = data.prompt.trim();
            if (userPrompt.startsWith('/sysprompt')) {
              this.aiClient.forceSystemPromptInjection();
              userPrompt = userPrompt.replace('/sysprompt', '').trim();
              if (!userPrompt) {
                userPrompt = "Please read my system instructions and acknowledge them.";
              }
            }
            
            let currentMessages: any[] = [{ role: 'user', content: userPrompt }];
            
            let maxIterations = 10;
            while (maxIterations-- > 0) {
              let toolCallToExecute: { tool: string, args: any } | null = null;
              
              for await (const chunk of this.aiClient.streamResponse(currentMessages, tokenSource.token)) {
                 if (chunk.type === 'text') {
                   this.sendToWebview({ type: 'streamChunk', chunk: chunk.content });
                 } else if (chunk.type === 'toolCall') {
                   toolCallToExecute = chunk as { tool: string, args: any };
                 }
              }
              
              if (toolCallToExecute) {
                 this.sendToWebview({ type: 'streamChunk', chunk: `\n\n> Executing tool: ${toolCallToExecute.tool}...\n` });
                 
                 const result = await this.workspaceAgent.executeToolCall(
                   toolCallToExecute, 
                   tokenSource.token
                 );
                 
                 this.sendToWebview({ type: 'toolResult', content: `Tool: ${toolCallToExecute.tool}\nResult:\n${result}` });
                 
                 currentMessages = [{ role: 'tool' as const, content: result }];
              } else {
                 break;
              }
            }
            
            this.sendToWebview({ type: 'streamEnd' });
          } catch (e: any) {
            this.logger.error('Error streaming response', e);
            this.sendToWebview({ type: 'assistantMessage', content: `Error: ${e.message}` });
            this.sendToWebview({ type: 'streamEnd' });
          }
          break;
        }
        case 'listFiles': {
          const tokenSource = new vscode.CancellationTokenSource();
          const result = await this.workspaceAgent.executeToolCall({ tool: 'listFiles' }, tokenSource.token);
          this.sendToWebview({ type: 'assistantMessage', content: result });
          break;
        }
        case 'readFile': {
          const tokenSource = new vscode.CancellationTokenSource();
          const result = await this.workspaceAgent.executeToolCall({ tool: 'readFile', args: { filePath: data.filePath } }, tokenSource.token);
          this.sendToWebview({ type: 'assistantMessage', content: result });
          break;
        }
        case 'searchWorkspace': {
          const tokenSource = new vscode.CancellationTokenSource();
          const result = await this.workspaceAgent.executeToolCall({ tool: 'searchWorkspace', args: { query: data.query } }, tokenSource.token);
          this.sendToWebview({ type: 'assistantMessage', content: result });
          break;
        }
        case 'getStatus': {
          this.aiClient.getStatus().then(status => {
            this.sendToWebview({ type: 'status', status });
            const history = this.aiClient.getConversationHistory();
            if (history.length > 0) {
              this.sendToWebview({ type: 'restoreHistory', history });
            }
          });
          break; 
        }
        case 'saveSettings': {
          const { provider, model, apiKey } = data.config;
          await vscode.workspace.getConfiguration('aiwb').update('provider', provider, true);
          await vscode.workspace.getConfiguration('aiwb').update('model', model, true);
          if (apiKey) {
            await this.aiClient.setApiKey(apiKey);
          }
          this.sendToWebview({ type: 'status', status: await this.aiClient.getStatus() });
          vscode.window.showInformationMessage('AI Workspace Bridge settings saved.');
          break;
        }
        case 'setSessionToken': {
          if (data.token) {
            await this.aiClient.setSessionToken(data.token);
            this.sendToWebview({ type: 'status', status: await this.aiClient.getStatus() });
            vscode.window.showInformationMessage("ChatGPT session token applied successfully!");
          }
          break;
        }
      }
    });
  }

  public sendToWebview(message: any) {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const isDev = false; // Always use built assets from gui/dist for now
    const nonce = this.getNonce();
    
    let scriptUri = '';
    let styleUri = '';
    
    if (isDev) {
      scriptUri = 'http://localhost:5173/src/main.tsx';
    } else {
      scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'gui', 'dist', 'assets', 'index.js')).toString();
      styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'gui', 'dist', 'assets', 'index.css')).toString();
    }

    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline' http://localhost:5173`,
      `script-src 'nonce-${nonce}' 'unsafe-eval' http://localhost:5173 http://localhost:5173/@vite/client http://localhost:5173/src/main.tsx`,
      `connect-src ${cspSource} http://localhost:5173 ws://localhost:5173 https://api.anthropic.com https://api.openai.com`,
      `font-src ${cspSource}`,
      `img-src ${cspSource} https: data:`
    ].join('; ');

    const styleTag = !isDev && styleUri ? `<link rel="stylesheet" href="${styleUri}">` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    :root {
      --vscode-editor-background: var(--vscode-editor-background);
      --vscode-editor-foreground: var(--vscode-editor-foreground);
      --vscode-input-background: var(--vscode-input-background);
      --vscode-button-background: var(--vscode-button-background);
      --vscode-button-foreground: var(--vscode-button-foreground);
    }
    body {
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 0;
      margin: 0;
      overflow: hidden;
    }
  </style>
  ${styleTag}
</head>
<body>
  <div id="root"></div>
  ${isDev ? `<script type="module" src="http://localhost:5173/@vite/client"></script>` : ''}
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
