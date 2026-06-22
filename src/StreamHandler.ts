import * as vscode from "vscode";
import { IStreamHandler } from "./types/ChatTypes";
import { Logger } from "./utils/Logger";

const TOKEN_DELAY_MS = 50;

interface FilePreview {
  relativePath: string;
  content: string;
}

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

        const filePreview = this.parseFilePreview(chunk);
        if (filePreview) {
          this.renderFilePreview(filePreview, response);
          await this.delay(TOKEN_DELAY_MS);
          continue;
        }

        response.markdown(this.enhanceWordHighlights(this.formatPotentialCodeResponse(chunk)));
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

  private parseFilePreview(value: string): FilePreview | null {
    const normalized = value.replace(/\r\n/g, "\n");
    const match = normalized.match(/^File:\s+(.+?)\n\n```\n([\s\S]*)\n```\s*$/);

    if (!match) {
      return null;
    }

    return {
      relativePath: match[1].trim(),
      content: match[2]
    };
  }

  private renderFilePreview(filePreview: FilePreview, response: vscode.ChatResponseStream): void {
    const uri = this.resolveWorkspaceUri(filePreview.relativePath);
    const language = this.getLanguageId(filePreview.relativePath);

    response.markdown(`**File:** \`${filePreview.relativePath}\``);

    if (uri) {
      response.button({
        command: "vscode.open",
        title: "Open file",
        arguments: [uri]
      });
    }

    response.markdown(`\n\n\`\`\`${language}\n${filePreview.content}\n\`\`\``);
  }

  private resolveWorkspaceUri(relativePath: string): vscode.Uri | null {
    const folder = vscode.workspace.workspaceFolders?.[0];

    if (!folder) {
      return null;
    }

    return vscode.Uri.joinPath(folder.uri, ...relativePath.replace(/\\/g, "/").split("/"));
  }

  private getLanguageId(relativePath: string): string {
    const extension = relativePath.split(".").pop()?.toLowerCase();

    switch (extension) {
      case "py":
        return "python";
      case "ts":
        return "typescript";
      case "tsx":
        return "tsx";
      case "js":
        return "javascript";
      case "jsx":
        return "jsx";
      case "json":
        return "json";
      case "md":
        return "markdown";
      case "html":
        return "html";
      case "css":
        return "css";
      case "yml":
      case "yaml":
        return "yaml";
      default:
        return "";
    }
  }

  private formatPotentialCodeResponse(value: string): string {
    if (value.includes("```")) {
      return value;
    }

    if (value.includes("\n")) {
      const wrappedMultiline = this.wrapMultilineCodeIfLikely(value);
      return wrappedMultiline ?? value;
    }

    const language = this.detectLanguageFromText(value);
    const codeStart = this.findCodeStartIndex(value);

    if (codeStart < 0) {
      return value;
    }

    const prose = value.slice(0, codeStart).trim();
    const codeRaw = value.slice(codeStart).trim();
    const code = this.reflowInlineCode(codeRaw);

    if (code.length < 12) {
      return value;
    }

    return `${prose}\n\n\`\`\`${language}\n${code}\n\`\`\``.trim();
  }

  private wrapMultilineCodeIfLikely(value: string): string | null {
    const normalized = value.replace(/\r\n/g, "\n").trim();
    const lines = normalized.split("\n");

    if (lines.length < 4) {
      return null;
    }

    const firstCodeLineIndex = lines.findIndex((line) => this.isLikelyCodeLine(line));
    if (firstCodeLineIndex < 0) {
      return null;
    }

    const candidateCodeLines = this.extractCodeRun(lines.slice(firstCodeLineIndex));
    if (candidateCodeLines.length < 4) {
      return null;
    }

    const codeLineHits = candidateCodeLines.filter((line) => this.isLikelyCodeLine(line)).length;
    const ratio = codeLineHits / candidateCodeLines.length;

    // Require a strong signal that this section is really code.
    if (ratio < 0.6) {
      return null;
    }

    const proseLines = lines.slice(0, firstCodeLineIndex);
    const prose = this.normalizeIntroProse(proseLines.join("\n"));
    const code = candidateCodeLines.join("\n");
    const language = this.detectLanguageFromText(normalized);
    const fenced = `\`\`\`${language}\n${code}\n\`\`\``;

    return prose ? `${prose}\n\n${fenced}` : fenced;
  }

  private detectLanguageFromText(value: string): string {
    const lower = value.toLowerCase();

    if (lower.includes("python")) {
      return "python";
    }
    if (lower.includes("javascript")) {
      return "javascript";
    }
    if (lower.includes("typescript")) {
      return "typescript";
    }

    return "";
  }

  private findCodeStartIndex(value: string): number {
    const markers = [
      /\bdef\s+[a-z_]\w*\s*\(/i,
      /\bclass\s+[A-Z_a-z]\w*/i,
      /\bfor\s+\w+\s+in\s+/i,
      /\bif\s+.+:/i,
      /\bwhile\s+.+:/i,
      /\bimport\s+\w+/i,
      /\bfrom\s+\w+\s+import\s+/i,
      /\bprint\s*\(/i,
      /\btry\s*:/i,
      /\bexcept\s+\w+/i
    ];

    let min = -1;
    for (const marker of markers) {
      const match = marker.exec(value);
      if (match && (min < 0 || match.index < min)) {
        min = match.index;
      }
    }

    return min;
  }

  private reflowInlineCode(code: string): string {
    let normalized = code.replace(/\r\n/g, "\n");

    // Recover common broken token boundaries like "... bdef foo" -> "... \ndef foo"
    normalized = normalized.replace(/([a-zA-Z])def\s+/g, "$1\ndef ");

    // Convert semi-colon style single-line snippets into readable multi-line code.
    normalized = normalized.replace(/;\s*/g, "\n");

    // Add line breaks before common Python control-flow markers when compacted.
    normalized = normalized
      .replace(/\s+(def\s+[a-zA-Z_]\w*\s*\()/g, "\n$1")
      .replace(/\s+(if\s+.+?:)/g, "\n$1")
      .replace(/\s+(for\s+.+?:)/g, "\n$1")
      .replace(/\s+(while\s+.+?:)/g, "\n$1")
      .replace(/\s+(try:)/g, "\n$1")
      .replace(/\s+(except\s+.+?:)/g, "\n$1")
      .replace(/\s+(return\s+)/g, "\n$1");

    return normalized.trim();
  }

  private isLikelyCodeLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed) {
      return false;
    }

    return (
      /^def\s+[a-zA-Z_]\w*\s*\(.*\)\s*:?\s*$/.test(trimmed) ||
      /^class\s+[A-Za-z_]\w*/.test(trimmed) ||
      /^(if|elif|else|for|while|try|except)\b/.test(trimmed) ||
      /^(return|print|import|from)\b/.test(trimmed) ||
      /^[a-zA-Z_]\w*\s*=\s*.+/.test(trimmed) ||
      /.+\(.+\)/.test(trimmed)
    );
  }

  private extractCodeRun(lines: string[]): string[] {
    const out: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        out.push(line);
        continue;
      }

      if (this.isLikelyCodeLine(line)) {
        out.push(line);
        continue;
      }

      if (this.isLikelyProseLine(trimmed)) {
        break;
      }

      out.push(line);
    }

    // Remove trailing blank lines from fenced output.
    while (out.length > 0 && !out[out.length - 1].trim()) {
      out.pop();
    }

    return out;
  }

  private isLikelyProseLine(trimmed: string): boolean {
    if (/^(tell me|let me know|if you want|what kind of|you can|here are)/i.test(trimmed)) {
      return true;
    }

    // Long natural-language line with no typical code punctuation.
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const hasCodePunctuation = /[{}[\];=]|->|::/.test(trimmed);
    const startsLikeCode = /^(def|class|if|elif|else|for|while|try|except|return|print|import|from)\b/.test(trimmed);
    return wordCount >= 6 && !hasCodePunctuation && !startsLikeCode;
  }

  private normalizeIntroProse(value: string): string {
    const lines = value
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, index, arr) => !(index === arr.length - 1 && /^python$/i.test(line.trim())));

    return lines.join("\n").trim();
  }

  private enhanceWordHighlights(value: string): string {
    if (value.includes("```")) {
      return value;
    }

    return value
      .replace(/\b(Error|ERROR)\b/g, "**$1**")
      .replace(/\b(Warning|WARNING)\b/g, "**$1**")
      .replace(/\b(Important|IMPORTANT)\b/g, "**$1**")
      .replace(/\b(Note|NOTE)\b/g, "**$1**");
  }
}
