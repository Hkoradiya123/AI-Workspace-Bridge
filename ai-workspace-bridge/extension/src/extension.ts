import * as vscode from 'vscode';
import { Logger } from './services/Logger';
import { WorkspaceAgent } from './services/WorkspaceAgent';
import { AIClient } from './services/AIClient';
import { SidebarProvider } from './SidebarProvider';

let statusBarItem: vscode.StatusBarItem;
let aiClient: AIClient;

export function activate(context: vscode.ExtensionContext) {
  const logger = new Logger('AI Workspace Bridge');
  logger.info('Extension activating...');

  const workspaceAgent = new WorkspaceAgent(logger);
  aiClient = new AIClient(context, logger);

  // Status Bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'aiwb.focusSidebar';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Sidebar Provider
  const sidebarProvider = new SidebarProvider(context, workspaceAgent, aiClient, logger);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Command to focus sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('aiwb.focusSidebar', () => {
      vscode.commands.executeCommand('aiwb.sidebarView.focus');
    })
  );

  // Listen to config changes to update status bar
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiwb.provider') || e.affectsConfiguration('aiwb.model')) {
        updateStatusBar();
      }
    })
  );

  // Refresh status bar periodically (mainly for Browser readiness check)
  const interval = setInterval(updateStatusBar, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  logger.info('Extension activated successfully.');
}

async function updateStatusBar() {
  if (!aiClient) return;
  
  try {
    const status = await aiClient.getStatus();
    
    if (status.connected) {
      statusBarItem.text = `$(robot) AIWB: Ready (${status.provider})`;
      statusBarItem.tooltip = `AI Workspace Bridge is connected via ${status.provider} (${status.model})`;
    } else {
      statusBarItem.text = `$(error) AIWB: Disconnected`;
      statusBarItem.tooltip = `AI Workspace Bridge is disconnected. Click to open and configure settings.`;
    }
    
    statusBarItem.show();
  } catch (e) {
    statusBarItem.text = `$(error) AIWB: Error`;
    statusBarItem.show();
  }
}

export function deactivate() {
  // Cleanup if needed
}
