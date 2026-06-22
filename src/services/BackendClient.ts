import * as vscode from "vscode";
import { IBackendClient } from "../types/ChatTypes";
import { Logger } from "../utils/Logger";
import { ChatGPTClient } from "./ChatGPTClient";
import { WorkspaceAgent, WorkspaceToolCall } from "./WorkspaceAgent";

const MAX_CHATGPT_TOOL_ROUNDS = 7;

interface RenderSegment {
  type: "text" | "code";
  content: string;
  language?: string;
}

interface RenderPayload {
  segments: RenderSegment[];
}

export class BackendClient implements IBackendClient, vscode.Disposable {
  private readonly chatGPTClient: ChatGPTClient;
  private readonly workspaceAgent: WorkspaceAgent;
  private sentChatGPTToolContext = false;
  private lastPrimedSessionEpoch = -1;
  private primeInFlight: Promise<void> | null = null;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.chatGPTClient = new ChatGPTClient(context, logger);
    this.workspaceAgent = new WorkspaceAgent(logger);
    this.bootstrapChatGPT().catch((error) => {
      this.logger.error("Failed to bootstrap ChatGPT", error);
    });
  }

  public async *sendPrompt(prompt: string, token: vscode.CancellationToken): AsyncIterable<string> {
    this.logger.info("Backend request started");

    const queue = new AsyncTextQueue();
    let isSuppressed = false;
    let buffer = "";
    let hasFlushedBuffer = false;

    const emit = (chunk: string) => {
      if (isSuppressed) {
        return;
      }

      if (!hasFlushedBuffer) {
        buffer += chunk;
        const lowerBuffer = buffer.toLowerCase();
        if (lowerBuffer.includes("render_json") || lowerBuffer.includes("tool_call") || lowerBuffer.includes("tool_result")) {
          isSuppressed = true;
          this.logger.info("Protocol detected in stream; suppressing live output.");
          return;
        }

        // Wait until we have enough text to be sure it's not a protocol marker,
        // or just flush if it's clearly prose (e.g. starts with a word).
        if (buffer.length >= 25) {
          queue.push(buffer);
          hasFlushedBuffer = true;
        }
        return;
      }

      queue.push(chunk);
    };

    void (async () => {
      try {
        const response = await this.getResponse(prompt, token, emit);
        
        let finalOutput = response;
        const containsProtocol = response && (response.includes("RENDER_JSON") || response.includes("TOOL_CALL"));

        if (response && response.includes("RENDER_JSON")) {
          finalOutput = this.formatStructuredRenderResponse(response);
        }

        if (isSuppressed || containsProtocol) {
          // If we suppressed the stream or the final response contains a protocol,
          // yield the clean (formatted) response.
          queue.push(finalOutput);
        } else if (!hasFlushedBuffer && buffer) {
          // Flush any remaining buffered prose that was never sent.
          queue.push(buffer);
        }
      } catch (error) {
        queue.push(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        queue.close();
        this.logger.info("Backend request finished");
      }
    })();

    for await (const chunk of queue) {
      if (token.isCancellationRequested) {
        this.logger.info("Backend request cancelled");
        break;
      }

      yield chunk;
    }
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

  private async getResponse(
    prompt: string,
    token: vscode.CancellationToken,
    emit?: (chunk: string) => void
  ): Promise<string> {
    if (this.chatGPTClient.canAttemptChatGPT()) {
      try {
        await this.primeSystemPromptIfNeeded(token);
        return await this.askChatGPTWithTools(prompt, token, emit);
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

  private async askChatGPTWithTools(
    prompt: string,
    token: vscode.CancellationToken,
    emit?: (chunk: string) => void
  ): Promise<string> {
    await this.primeSystemPromptIfNeeded(token);

    const cleanPrompt = this.cleanUserPrompt(prompt);
    const allowLiveStream = !this.needsWorkspaceMutation(cleanPrompt, "") && !this.isLikelyCodeRequest(cleanPrompt);

    if (this.isSystemPromptCommand(cleanPrompt)) {
      return this.resendSystemPrompt(token);
    }

    let modelPrompt = this.buildModelPrompt(cleanPrompt);

    for (let round = 0; round < MAX_CHATGPT_TOOL_ROUNDS; round += 1) {
      const shouldStreamRound = round === 0 && allowLiveStream && !modelPrompt.includes("TOOL_RESULT");
      const response = await this.chatGPTClient.askQuestionWithStreaming(
        modelPrompt,
        token,
        shouldStreamRound ? emit : undefined
      );
      
      // Check for ChatGPT native tool attempts
      const nativeToolRejection = this.detectAndRejectNativeTools(response);
      if (nativeToolRejection) {
        modelPrompt = nativeToolRejection;
        continue;
      }
      
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        if (this.containsToolCall(response)) {
          return "ChatGPT tried to request a VS Code tool, but the TOOL_CALL JSON was invalid. Ask it to retry using valid one-line JSON. For multi-line file content, it should use `contentBase64`.";
        }

        if (this.needsWorkspaceMutation(cleanPrompt, response)) {
          modelPrompt = this.buildMissingToolCorrectionPrompt(cleanPrompt, response);
          continue;
        }

        if (shouldStreamRound) {
          return "";
        }

        return this.formatStructuredRenderResponse(response);
      }

      this.logger.info(`ChatGPT requested tool: ${toolCall.tool}`);
      const toolResult = await this.workspaceAgent.executeToolCall(toolCall, token, emit);
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

  private async bootstrapChatGPT(): Promise<void> {
    await this.chatGPTClient.initialize();
    await this.primeSystemPromptIfNeeded();
  }

  private async primeSystemPromptIfNeeded(token?: vscode.CancellationToken): Promise<void> {
    if (!this.chatGPTClient.canAttemptChatGPT()) {
      return;
    }

    if (token?.isCancellationRequested) {
      return;
    }

    const reopened = await this.chatGPTClient.ensureBrowserReady();
    const currentEpoch = this.chatGPTClient.getSessionEpoch();
    const shouldPrime = reopened || !this.sentChatGPTToolContext || this.lastPrimedSessionEpoch !== currentEpoch;

    if (!shouldPrime) {
      return;
    }

    if (this.primeInFlight) {
      await this.primeInFlight;
      return;
    }

    this.primeInFlight = (async () => {
      const cts = new vscode.CancellationTokenSource();
      try {
        const primePrompt = this.buildInitialSystemPrompt(
          "Acknowledge this setup in one short sentence. Do not call tools yet."
        );
        await this.chatGPTClient.askQuestion(primePrompt, token ?? cts.token);
        this.sentChatGPTToolContext = true;
        this.lastPrimedSessionEpoch = this.chatGPTClient.getSessionEpoch();
        this.logger.info(`System prompt primed for session epoch ${this.lastPrimedSessionEpoch}.`);
      } catch (error) {
        this.logger.warn(`System prompt priming failed: ${error}`);
      } finally {
        cts.dispose();
        this.primeInFlight = null;
      }
    })();

    await this.primeInFlight;
  }

  private buildInitialSystemPrompt(userPrompt: string): string {
    return [
        "SYSTEM MESSAGE FOR THIS VS CODE AGENT SESSION",
        "You are the reasoning brain for a VS Code extension called AI Workspace Bridge.",
        "You cannot directly read files or run VS Code APIs from ChatGPT.",
        "You do NOT have access to ChatGPT's native tools (code_interpreter, web_browser, file_search, etc.).",
        "The ONLY tools you can use are listed below. Ignore any other tool schemas.",
        "The extension can execute tools for you if you request them with the exact protocol below.",
        this.workspaceAgent.getToolManifestForModel(),
      "",
      "User request:",
      userPrompt,
      "",
      "CRITICAL RULES:",
      "1. If you can answer without workspace access, answer normally.",
      "2. If you need workspace access, reply ONLY with valid one-line TOOL_CALL JSON - nothing else.",
      "3. Do NOT attempt to use ChatGPT's native tools. They will not work. Only use tools from the list above.",
      "4. Never claim a file was created, modified, or deleted unless you first issued a TOOL_CALL writeFile and received TOOL_RESULT.",
      "5. For writeFile with code or multi-line text, use contentBase64 to keep JSON valid on one line.",
      "6. Wait for TOOL_RESULT after each TOOL_CALL before deciding what to do next.",
      "7. If you accidentally try to use a ChatGPT native tool, the extension will reject it and ask you to use the workspace tools instead.",
      "8. For final user-facing answers (when not sending TOOL_CALL), prefer this exact render format:",
      "RENDER_JSON {\"segments\":[{\"type\":\"text\",\"content\":\"...\"},{\"type\":\"code\",\"language\":\"python\",\"content\":\"...\"}]}",
      "9. Keep non-code explanation in text segments and code only in code segments."
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
      "Now answer the user using the tool result.",
      "If the tool result contains markdown headings, lists, or fenced code blocks, preserve that formatting exactly.",
      "For terminal results, show only the terminal transcript.",
      "Do not repeat or explain the transcript unless the user asks.",
      "If the command succeeded, keep the response concise.",
      "Prefer final answers as RENDER_JSON with segments when it helps separate prose and code cleanly.",
      "If you need another tool, reply only with another TOOL_CALL JSON."
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

  private detectAndRejectNativeTools(response: string): string | null {
    // Detect ChatGPT native tool mentions: code_interpreter, web_browser, file_search, retrieval, function calls, etc.
    const nativeToolPatterns = [
      /\bcode_interpreter\b/i,
      /\bweb_browser\b/i,
      /\bfile_search\b/i,
      /\bretrieval\b/i,
      /\bfunction\s+call/i,
      /\buse code\b/i,
      /\bbrowse\b/i,
      /\bexecute code\b/i,
      /\brun python\b/i,
      /\brun javascript\b/i,
      /"type"\s*:\s*"function"/i,
      /"tool"\s*:\s*"code_interpreter"/i,
      /`````/  // Code fence that suggests code execution
    ];

    const detected = nativeToolPatterns.some(pattern => pattern.test(response));
    
    if (detected) {
      this.logger.warn("ChatGPT attempted to use native tools. Redirecting to workspace tools.");
      return this.buildNativeToolRejectionPrompt(response);
    }

    return null;
  }

  private buildNativeToolRejectionPrompt(previousResponse: string): string {
    return [
      "ERROR: You attempted to use a ChatGPT native tool (code_interpreter, web_browser, file_search, etc.).",
      "These tools are NOT available in this environment.",
      "",
      "You ONLY have access to the following VS Code workspace tools:",
      "- listFiles",
      "- readFile",
      "- writeFile",
      "- searchWorkspace",
      "- summarizeWorkspace",
      "",
      "Your previous attempt:",
      previousResponse,
      "",
      "Please retry using ONLY the workspace tools listed above.",
      "Format: TOOL_CALL {\"tool\":\"toolName\",\"args\":{...}}"
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

  private isLikelyCodeRequest(prompt: string): boolean {
    return /\b(code|python|javascript|typescript|script|function|class|program|algorithm)\b/i.test(prompt);
  }

  private formatStructuredRenderResponse(raw: string): string {
    const payload = this.tryParseRenderPayload(raw);
    if (!payload) {
      return raw;
    }

    const parts: string[] = [];

    for (const segment of payload.segments) {
      if (!segment || typeof segment.content !== "string") {
        continue;
      }

      if (segment.type === "code") {
        const language = typeof segment.language === "string" ? segment.language.trim() : "";
        parts.push(`\`\`\`${language}\n${segment.content}\n\`\`\``.trim());
      } else if (segment.type === "text") {
        parts.push(segment.content.trim());
      }
    }

    return parts.filter(Boolean).join("\n\n").trim() || raw;
  }

  private tryParseRenderPayload(raw: string): RenderPayload | null {
    const trimmed = raw.trim();
    const prefixed = trimmed.match(/^RENDER_JSON\s*(\{[\s\S]*\})$/i);
    const candidate = prefixed ? prefixed[1] : (trimmed.startsWith("{") ? trimmed : null);

    if (!candidate) {
      return null;
    }

    try {
      const parsed = JSON.parse(candidate) as any;
      if (parsed && parsed.segments) {
        if (Array.isArray(parsed.segments)) {
          return parsed as RenderPayload;
        }
        if (typeof parsed.segments === "object" && typeof (parsed.segments as any).content === "string") {
          return { segments: [parsed.segments] } as RenderPayload;
        }
      }
      return null;
    } catch {
      const normalized = this.normalizeLooseJson(candidate);
      if (!normalized) {
        return null;
      }

      try {
        const parsed = JSON.parse(normalized) as any;
        if (parsed && parsed.segments) {
          if (Array.isArray(parsed.segments)) {
            return parsed as RenderPayload;
          }
          if (typeof parsed.segments === "object" && typeof (parsed.segments as any).content === "string") {
            return { segments: [parsed.segments] } as RenderPayload;
          }
        }
        return null;
      } catch {
        return null;
      }
    }
  }

  private normalizeLooseJson(input: string): string | null {
    // Convert JS-like single-quoted keys/values into strict JSON for tolerant parsing.
    // This is intentionally conservative and only used as a fallback.
    let output = input.trim();

    if (!output.startsWith("{") || !output.endsWith("}")) {
      return null;
    }

    output = output.replace(/([{,]\s*)'([^'\\]+)'\s*:/g, "$1\"$2\":");
    output = output.replace(/:\s*'((?:\\'|[^'])*)'/g, (_match, value: string) => {
      const unescaped = value.replace(/\\'/g, "'");
      const escaped = unescaped
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return `: "${escaped}"`;
    });

    return output;
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

}

class AsyncTextQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
  private closed = false;

  public push(value: string): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  public close(): void {
    this.closed = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as unknown as string, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this.values.length > 0) {
          const value = this.values.shift() as string;
          return { value, done: false };
        }

        if (this.closed) {
          return { value: undefined as unknown as string, done: true };
        }

        return new Promise<IteratorResult<string>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}
