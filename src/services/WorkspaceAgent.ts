import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "../utils/Logger";

interface AgentResult {
  handled: boolean;
  response: string;
}

interface AgentTool {
  name: string;
  trigger: string;
  access: string;
  safety: string;
}

export interface WorkspaceToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

const EXCLUDE_GLOB = "{**/node_modules/**,**/dist/**,**/.git/**}";
const MAX_LIST_FILES = 80;
const MAX_SEARCH_FILES = 120;
const MAX_FILE_PREVIEW_CHARS = 12000;
const MAX_SUMMARY_FILES = 35;
const MAX_SUMMARY_FILE_CHARS = 20000;

const AGENT_TOOLS: AgentTool[] = [
  {
    name: "listFiles",
    trigger: "list files / read all files / files",
    access: "Reads workspace file names through vscode.workspace.findFiles.",
    safety: "Skips node_modules, dist, and .git."
  },
  {
    name: "readFile",
    trigger: "read file <path>",
    access: "Reads one file inside the current workspace through vscode.workspace.fs.readFile.",
    safety: "Refuses paths outside the workspace and truncates large previews."
  },
  {
    name: "summarizeWorkspace",
    trigger: "summarize project / read all files and tell me",
    access: "Reads important workspace text files and produces a local project summary.",
    safety: "Skips node_modules, dist, .git, binary/unreadable files, and caps file count/content size."
  },
  {
    name: "searchWorkspace",
    trigger: "search <text> / find <text> / grep <text>",
    access: "Searches readable workspace files for a text query.",
    safety: "Skips node_modules, dist, .git, binary/unreadable files, and caps results."
  },
  {
    name: "writeFile",
    trigger: "write file <path>: <content>",
    access: "Writes a file inside the current workspace through vscode.workspace.fs.writeFile.",
    safety: "Requires a VS Code confirmation dialog and refuses paths outside the workspace."
  },
  {
    name: "chatgptBrowser",
    trigger: "normal chat fallback",
    access: "Can try to use the visible ChatGPT browser session when configured.",
    safety: "Falls back to local mock responses if the browser is not logged in or cannot reach the prompt."
  }
];

export class WorkspaceAgent {
  public constructor(private readonly logger: Logger) {}

  public getToolManifestForModel(): string {
    const tools = AGENT_TOOLS
      .filter((tool) => tool.name !== "chatgptBrowser")
      .map((tool) => {
        return [
          `- ${tool.name}`,
          `  Trigger: ${tool.trigger}`,
          `  Access: ${tool.access}`,
          `  Safety: ${tool.safety}`
        ].join("\n");
      })
      .join("\n");

    return [
      "Available VS Code tools:",
      tools,
      "",
      "Tool call protocol:",
      "When you need a tool, reply with exactly one line:",
      "TOOL_CALL {\"tool\":\"toolName\",\"args\":{}}",
      "",
      "Supported tool args:",
      "- listFiles: {}",
      "- summarizeWorkspace: {}",
      "- readFile: {\"filePath\":\"relative/path\"}",
      "- searchWorkspace: {\"query\":\"text\"}",
      "- writeFile: {\"filePath\":\"relative/path\",\"content\":\"text\"}",
      "- writeFile for multi-line content: {\"filePath\":\"relative/path\",\"contentBase64\":\"base64-encoded utf8 text\"}",
      "",
      "For writeFile with code or multi-line text, prefer contentBase64 so the JSON stays valid.",
      "If the user asks you to create, build, implement, edit, update, or fix files, you must use writeFile.",
      "Never claim that a file was created or edited unless you requested writeFile and received TOOL_RESULT.",
      "Do not pretend you used a tool. Ask for a tool with TOOL_CALL and wait for TOOL_RESULT."
    ].join("\n");
  }

  public async executeToolCall(call: WorkspaceToolCall, token: vscode.CancellationToken): Promise<string> {
    const args = call.args ?? {};

    switch (call.tool) {
      case "listFiles":
        return this.listFiles(token);
      case "summarizeWorkspace":
        return this.summarizeWorkspace(token);
      case "readFile":
        return this.readFile(this.getStringArg(args, "filePath"));
      case "searchWorkspace":
        return this.search(this.getStringArg(args, "query"), token);
      case "writeFile":
        return this.writeFile(this.getStringArg(args, "filePath"), this.getWriteContent(args));
      default:
        return `Unknown tool \`${call.tool}\`.`;
    }
  }

  public async tryHandle(prompt: string, token: vscode.CancellationToken): Promise<AgentResult> {
    const normalized = prompt.trim();
    const lower = normalized.toLowerCase();

    if (!normalized) {
      return this.unhandled();
    }

    if (lower === "agent help" || lower === "help agent" || lower === "tools") {
      return this.handled(this.help());
    }

    if (this.isAgentContextRequest(lower)) {
      return this.handled(this.agentContext());
    }

    if (this.isSummarizeWorkspaceRequest(lower)) {
      return this.handled(await this.summarizeWorkspace(token));
    }

    if (this.isListFilesRequest(lower)) {
      return this.handled(await this.listFiles(token));
    }

    const readPath = this.matchReadFile(normalized);
    if (readPath) {
      return this.handled(await this.readFile(readPath));
    }

    const searchQuery = this.matchSearch(normalized);
    if (searchQuery) {
      return this.handled(await this.search(searchQuery, token));
    }

    const writeRequest = this.matchWriteFile(normalized);
    if (writeRequest) {
      return this.handled(await this.writeFile(writeRequest.filePath, writeRequest.content));
    }

    return this.unhandled();
  }

  private help(): string {
    return [
      "Workspace agent tools available:",
      "",
      ...AGENT_TOOLS.map((tool) => `- \`${tool.trigger}\` - ${tool.name}`),
      "",
      "Ask `agent context` to see the local tool manifest and access limits."
    ].join("\n");
  }

  private agentContext(): string {
    const folder = this.getWorkspaceFolder();
    const workspace = folder ? folder.uri.fsPath : "No workspace folder is open";
    const tools = AGENT_TOOLS.map((tool) => {
      return [
        `### ${tool.name}`,
        `- Trigger: \`${tool.trigger}\``,
        `- Access: ${tool.access}`,
        `- Safety: ${tool.safety}`
      ].join("\n");
    }).join("\n\n");

    return [
      "Local agent context:",
      "",
      `- Workspace: ${workspace}`,
      "- Runtime: VS Code extension host",
      "- Network: no direct model API is configured",
      "- MCP: no external MCP server is connected inside this extension yet",
      "- Local authority: VS Code workspace APIs plus the visible ChatGPT browser fallback",
      "",
      "Tool manifest:",
      "",
      tools,
      "",
      "Current limitation: this is a deterministic local tool router, not a reasoning model with automatic multi-step planning yet."
    ].join("\n");
  }

  private async listFiles(token: vscode.CancellationToken): Promise<string> {
    const folder = this.getWorkspaceFolder();

    if (!folder) {
      return "No workspace folder is open.";
    }

    const files = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, MAX_LIST_FILES, token);

    if (files.length === 0) {
      return "No files found in the workspace.";
    }

    const lines = files.map((file) => `- ${vscode.workspace.asRelativePath(file, false)}`);
    const suffix = files.length === MAX_LIST_FILES ? "\n\nShowing first 80 files." : "";
    return `Workspace files:\n\n${lines.join("\n")}${suffix}`;
  }

  private async summarizeWorkspace(token: vscode.CancellationToken): Promise<string> {
    const folder = this.getWorkspaceFolder();

    if (!folder) {
      return "No workspace folder is open.";
    }

    const files = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, 300, token);
    const selectedFiles = files
      .filter((file) => this.isSummarizableFile(file))
      .sort((a, b) => this.summaryPriority(a) - this.summaryPriority(b))
      .slice(0, MAX_SUMMARY_FILES);

    if (selectedFiles.length === 0) {
      return "I did not find readable project files to summarize.";
    }

    const packageSummary = await this.summarizePackageJson(selectedFiles);
    const fileSummaries: string[] = [];

    for (const file of selectedFiles) {
      if (token.isCancellationRequested) {
        break;
      }

      const summary = await this.summarizeFile(file);

      if (summary) {
        fileSummaries.push(summary);
      }
    }

    const suffix = selectedFiles.length === MAX_SUMMARY_FILES
      ? "\n\nNote: summary capped at 35 files. Use `read file <path>` for details."
      : "";

    return [
      "Project summary:",
      "",
      packageSummary,
      "",
      "Files inspected:",
      "",
      fileSummaries.join("\n"),
      suffix
    ].filter(Boolean).join("\n");
  }

  private async readFile(inputPath: string): Promise<string> {
    const uri = this.resolveWorkspaceFile(inputPath);

    if (!uri) {
      return "No workspace folder is open.";
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const preview = text.length > MAX_FILE_PREVIEW_CHARS
        ? `${text.slice(0, MAX_FILE_PREVIEW_CHARS)}\n\n...truncated...`
        : text;

      return `File: ${relativePath}\n\n\`\`\`\n${preview}\n\`\`\``;
    } catch (error) {
      this.logger.error(`Failed to read file ${inputPath}`, error);
      return `I could not read \`${inputPath}\`. Check the path and try again.`;
    }
  }

  private async search(query: string, token: vscode.CancellationToken): Promise<string> {
    const folder = this.getWorkspaceFolder();

    if (!folder) {
      return "No workspace folder is open.";
    }

    const files = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, MAX_SEARCH_FILES, token);
    const matches: string[] = [];
    const needle = query.toLowerCase();

    for (const file of files) {
      if (token.isCancellationRequested || matches.length >= 40) {
        break;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const text = new TextDecoder().decode(bytes);
        const lines = text.split(/\r?\n/);

        lines.forEach((line, index) => {
          if (matches.length >= 40) {
            return;
          }

          if (line.toLowerCase().includes(needle)) {
            const relativePath = vscode.workspace.asRelativePath(file, false);
            matches.push(`- ${relativePath}:${index + 1} ${line.trim()}`);
          }
        });
      } catch {
        // Skip binary or unreadable files.
      }
    }

    if (matches.length === 0) {
      return `No matches found for \`${query}\`.`;
    }

    const suffix = matches.length >= 40 ? "\n\nShowing first 40 matches." : "";
    return `Search results for \`${query}\`:\n\n${matches.join("\n")}${suffix}`;
  }

  private async writeFile(inputPath: string, content: string): Promise<string> {
    const uri = this.resolveWorkspaceFile(inputPath);

    if (!uri) {
      return "No workspace folder is open.";
    }

    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const answer = await vscode.window.showWarningMessage(
      `Write ${relativePath}?`,
      { modal: true },
      "Write file"
    );

    if (answer !== "Write file") {
      return `Cancelled writing \`${relativePath}\`.`;
    }

    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      return `Wrote \`${relativePath}\`.`;
    } catch (error) {
      this.logger.error(`Failed to write file ${inputPath}`, error);
      return `I could not write \`${inputPath}\`.`;
    }
  }

  private matchReadFile(prompt: string): string | null {
    const match = prompt.match(/^(?:read|open|show)\s+(?:file\s+)?(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  private isListFilesRequest(prompt: string): boolean {
    return /^(list|show)\s+(workspace\s+)?files\b/.test(prompt)
      || /^(read|reed|readd|reall)\s+(all|alll)?\s*files\b/.test(prompt)
      || /^(read|reed|readd)\s+(my\s+)?(all|alll)\s+files\b/.test(prompt)
      || prompt === "files";
  }

  private isSummarizeWorkspaceRequest(prompt: string): boolean {
    return /^(summarize|summarise|explain|overview)\s+(project|workspace|codebase)\b/.test(prompt)
      || /^(read|reed|readd)\s+(all|alll)\s+files\s+(and\s+)?(tell|summarize|summarise|explain|overview)\b/.test(prompt)
      || /^(read|reed|readd)\s+my\s+(all|alll)\s+files\b/.test(prompt)
      || /^what\s+is\s+this\s+(project|workspace|codebase)/.test(prompt);
  }

  private isAgentContextRequest(prompt: string): boolean {
    return /^(agent\s+)?(context|capabilities|capability|tools|tool\s+access|mcp|manifest)\b/.test(prompt)
      || /what\s+(tools|access|mcp).*(you|agent)\s+have/.test(prompt)
      || /what\s+can\s+(you|agent)\s+(do|access)/.test(prompt);
  }

  private matchSearch(prompt: string): string | null {
    const match = prompt.match(/^(?:search|find|grep)\s+(.+)$/i);
    return this.stripQuotes(match?.[1]?.trim() || "");
  }

  private matchWriteFile(prompt: string): { filePath: string; content: string } | null {
    const match = prompt.match(/^(?:write|create)\s+file\s+(.+?):\s*([\s\S]+)$/i);

    if (!match) {
      return null;
    }

    return {
      filePath: match[1].trim(),
      content: match[2]
    };
  }

  private stripQuotes(value: string): string | null {
    const stripped = value.replace(/^["']|["']$/g, "").trim();
    return stripped || null;
  }

  private getStringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key];

    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Tool argument ${key} is required.`);
    }

    return value;
  }

  private getWriteContent(args: Record<string, unknown>): string {
    const contentBase64 = args.contentBase64;

    if (typeof contentBase64 === "string" && contentBase64.trim()) {
      return Buffer.from(contentBase64, "base64").toString("utf8");
    }

    return this.getStringArg(args, "content");
  }

  private resolveWorkspaceFile(inputPath: string): vscode.Uri | null {
    const folder = this.getWorkspaceFolder();

    if (!folder) {
      return null;
    }

    const rootPath = folder.uri.fsPath;
    const resolvedPath = path.resolve(rootPath, inputPath.replace(/^["']|["']$/g, ""));
    const rootWithSeparator = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;

    if (resolvedPath !== rootPath && !resolvedPath.startsWith(rootWithSeparator)) {
      throw new Error("Refusing to access files outside the workspace.");
    }

    return vscode.Uri.file(resolvedPath);
  }

  private isSummarizableFile(uri: vscode.Uri): boolean {
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    const ext = path.extname(relativePath).toLowerCase();
    const fileName = path.basename(relativePath).toLowerCase();

    if (fileName.endsWith(".lock") || fileName.endsWith(".map") || fileName.endsWith(".zip")) {
      return false;
    }

    return [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".md",
      ".css",
      ".html",
      ".py",
      ".yml",
      ".yaml"
    ].includes(ext);
  }

  private summaryPriority(uri: vscode.Uri): number {
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/").toLowerCase();

    if (relativePath === "package.json") {
      return 0;
    }

    if (relativePath === "readme.md") {
      return 1;
    }

    if (relativePath.startsWith("src/")) {
      return 2;
    }

    if (relativePath.includes("test") || relativePath.includes("spec")) {
      return 4;
    }

    return 3;
  }

  private async summarizePackageJson(files: vscode.Uri[]): Promise<string> {
    const packageFile = files.find((file) => vscode.workspace.asRelativePath(file, false).replace(/\\/g, "/") === "package.json");

    if (!packageFile) {
      return "No `package.json` found in inspected files.";
    }

    try {
      const text = await this.readText(packageFile);
      const pkg = JSON.parse(text) as {
        name?: string;
        description?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = Object.keys(pkg.scripts ?? {});
      const dependencies = Object.keys(pkg.dependencies ?? {});
      const devDependencies = Object.keys(pkg.devDependencies ?? {});

      return [
        `Package: ${pkg.name ?? "unknown"}`,
        pkg.description ? `Description: ${pkg.description}` : "",
        scripts.length ? `Scripts: ${scripts.join(", ")}` : "",
        dependencies.length ? `Dependencies: ${dependencies.join(", ")}` : "",
        devDependencies.length ? `Dev dependencies: ${devDependencies.join(", ")}` : ""
      ].filter(Boolean).join("\n");
    } catch {
      return "Found `package.json`, but could not parse it.";
    }
  }

  private async summarizeFile(uri: vscode.Uri): Promise<string | null> {
    try {
      const text = await this.readText(uri);
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const limitedText = text.slice(0, MAX_SUMMARY_FILE_CHARS);
      const lines = limitedText.split(/\r?\n/);
      const facts = this.extractFileFacts(relativePath, lines);
      return `- ${relativePath}: ${facts}`;
    } catch {
      return null;
    }
  }

  private extractFileFacts(relativePath: string, lines: string[]): string {
    const ext = path.extname(relativePath).toLowerCase();
    const nonEmptyLines = lines.filter((line) => line.trim()).length;

    if (ext === ".md") {
      const heading = lines.find((line) => /^#\s+/.test(line.trim()))?.replace(/^#\s+/, "").trim();
      return heading ? `Markdown doc, heading "${heading}", ${nonEmptyLines} non-empty lines.` : `Markdown doc, ${nonEmptyLines} non-empty lines.`;
    }

    if (ext === ".json") {
      return `JSON config/data file, ${nonEmptyLines} non-empty lines.`;
    }

    const imports = lines.filter((line) => /^\s*import\s+/.test(line)).length;
    const symbols = lines
      .map((line) => line.match(/\b(?:export\s+)?(?:class|function|interface|type|const)\s+([A-Za-z0-9_]+)/)?.[1])
      .filter((value): value is string => !!value)
      .slice(0, 6);

    const symbolText = symbols.length ? ` Symbols: ${symbols.join(", ")}.` : "";
    return `${nonEmptyLines} non-empty lines, ${imports} imports.${symbolText}`;
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  }

  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private handled(response: string): AgentResult {
    return { handled: true, response };
  }

  private unhandled(): AgentResult {
    return { handled: false, response: "" };
  }
}
