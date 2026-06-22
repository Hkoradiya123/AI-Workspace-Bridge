import * as vscode from 'vscode';
import { Logger } from './Logger';
import { ChatGPTClient } from './ChatGPTClient';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export type StreamChunk = 
  | { type: 'text'; content: string }
  | { type: 'toolCall'; tool: string; args: any };

export class AIClient {
  private chatGptClient: ChatGPTClient;
  private conversationHistory: ChatMessage[] = [];

  constructor(private context: vscode.ExtensionContext, private logger: Logger) {
    this.chatGptClient = new ChatGPTClient(context, logger);
    
    // Load persisted history from workspace state
    const savedHistory = this.context.workspaceState.get<ChatMessage[]>('aiwb.chatHistory');
    if (savedHistory && Array.isArray(savedHistory)) {
      this.conversationHistory = savedHistory;
    }

    // Initialize browser client asynchronously
    this.chatGptClient.initialize().catch(err => {
      this.logger.error("Failed to initialize ChatGPT browser client", err);
    });
  }

  public getConversationHistory(): ChatMessage[] {
    return this.conversationHistory;
  }

  public clearHistory(): void {
    this.conversationHistory = [];
    this.context.workspaceState.update('aiwb.chatHistory', []);
  }

  private saveHistory(): void {
    this.context.workspaceState.update('aiwb.chatHistory', this.conversationHistory);
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('aiwb');
    return {
      provider: config.get<string>('provider', 'browser'),
      model: config.get<string>('model', 'gpt-4o')
    };
  }

  public async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store('aiwb.apiKey', key);
  }

  public async getApiKey(): Promise<string | undefined> {
    return await this.context.secrets.get('aiwb.apiKey');
  }

  public async setSessionToken(token: string): Promise<void> {
    await this.chatGptClient.setToken(token);
  }

  public async getStatus(): Promise<{ connected: boolean, provider: string, model: string }> {
    const { provider, model } = this.getConfig();
    
    if (provider === 'browser') {
      const status = this.chatGptClient.getStatus();
      return { 
        connected: status.isBrowserReady || status.hasToken, 
        provider, 
        model: 'chatgpt-browser' 
      };
    } else {
      const key = await this.getApiKey();
      return { connected: !!key, provider, model };
    }
  }

  private getSystemPrompt(): string {
    return `You are an AI coding assistant with access to the user's VS Code workspace. You can read files, search code, and write files using tools. When you need workspace access, output exactly: TOOL_CALL {"tool":"toolName","args":{}} on its own line.
Available tools:
- listFiles: {}
- readFile: {"filePath": "string"}
- searchWorkspace: {"query": "string"}
- writeFile: {"filePath": "string", "content": "string"}
- summarizeWorkspace: {}`;
  }

  private lastBrowserEpoch = -1;

  public forceSystemPromptInjection(): void {
    this.lastBrowserEpoch = -1;
  }

  public async *streamResponse(messages: ChatMessage[], token: vscode.CancellationToken): AsyncGenerator<StreamChunk> {
    // Add to memory history
    this.conversationHistory.push(...messages);
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(this.conversationHistory.length - 20);
    }
    this.saveHistory();

    const { provider, model } = this.getConfig();

    const fullMessages = [
      { role: 'system', content: this.getSystemPrompt() },
      ...this.conversationHistory
    ];

    let responseText = '';

    if (provider === 'browser') {
      yield* this.streamBrowser(messages, token, (text) => responseText += text);
    } else if (provider === 'openai') {
      yield* this.streamOpenAI(fullMessages, model, token, (text) => responseText += text);
    } else if (provider === 'anthropic') {
      yield* this.streamAnthropic(fullMessages, model, token, (text) => responseText += text);
    } else {
      yield { type: 'text', content: `Unknown provider: ${provider}` };
    }

    // After stream completes, check if there was a tool call in the accumulated response
    const toolCallMatch = responseText.match(/TOOL_CALL\s*({.*})/);
    if (toolCallMatch) {
      try {
        const parsed = JSON.parse(toolCallMatch[1]);
        if (parsed.tool) {
          yield { type: 'toolCall', tool: parsed.tool, args: parsed.args || {} };
        }
      } catch (e) {
        this.logger.error("Failed to parse tool call JSON", e);
      }
    }
    
    // Add assistant response to history
    this.conversationHistory.push({ role: 'assistant', content: responseText });
    this.saveHistory();
  }

  private async *streamBrowser(newMessages: ChatMessage[], token: vscode.CancellationToken, onText: (t: string) => void): AsyncGenerator<StreamChunk> {
    const currentEpoch = this.chatGptClient.getSessionEpoch();
    let promptToType = "";

    // If it's a fresh browser session (or first time), inject system prompt and context
    if (this.lastBrowserEpoch !== currentEpoch) {
      this.lastBrowserEpoch = currentEpoch;
      promptToType += `[SYSTEM INSTRUCTIONS: YOU MUST FOLLOW THESE]\n${this.getSystemPrompt()}\n\n`;
      
      const pastHistory = this.conversationHistory.slice(0, -newMessages.length);
      if (pastHistory.length > 0) {
        promptToType += `[PREVIOUS CHAT HISTORY]\n`;
        promptToType += pastHistory.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
        promptToType += `\n\n[LATEST PROMPT]\n`;
      }
    }

    promptToType += newMessages.map(m => {
      if (m.role === 'tool') return `[TOOL RESULT]:\n${m.content}`;
      return m.content;
    }).join('\n\n');
    
    let resolveNext: (() => void) | null = null;
    const queue: string[] = [];
    let isDone = false;
    let error: any = null;

    const onChunk = (chunk: string) => {
      queue.push(chunk);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.chatGptClient.askQuestionWithStreaming(promptToType, token, onChunk)
      .then(() => { isDone = true; if (resolveNext) resolveNext(); })
      .catch(err => { error = err; isDone = true; if (resolveNext) resolveNext(); });

    while (!isDone || queue.length > 0) {
      if (queue.length > 0) {
        const chunk = queue.shift()!;
        onText(chunk);
        yield { type: 'text', content: chunk };
      } else {
        await new Promise<void>(resolve => { resolveNext = resolve; });
      }
    }
    if (error) throw error;
  }

  private async *streamOpenAI(messages: any[], model: string, token: vscode.CancellationToken, onText: (t: string) => void): AsyncGenerator<StreamChunk> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("OpenAI API Key is not set.");

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      }),
      signal: this.toAbortSignal(token)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API Error ${response.status}: ${text}`);
    }

    yield* this.parseSSE(response.body as any, (data) => {
      if (data === '[DONE]') return null;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          onText(content);
          return { type: 'text', content };
        }
      } catch (e) {}
      return null;
    });
  }

  private async *streamAnthropic(messages: any[], model: string, token: vscode.CancellationToken, onText: (t: string) => void): AsyncGenerator<StreamChunk> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("Anthropic API Key is not set.");

    const systemMessage = messages.find(m => m.role === 'system')?.content;
    const chatMessages = messages.filter(m => m.role !== 'system');

    // Claude uses alternating user/assistant messages.
    // We map 'tool' role to 'user' for Claude because standard messages API only allows user/assistant.
    const anthropicMessages = chatMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        system: systemMessage,
        messages: anthropicMessages,
        stream: true,
        max_tokens: 4096
      }),
      signal: this.toAbortSignal(token)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API Error ${response.status}: ${text}`);
    }

    yield* this.parseSSE(response.body as any, (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          onText(parsed.delta.text);
          return { type: 'text', content: parsed.delta.text };
        }
      } catch (e) {}
      return null;
    });
  }

  private async *parseSSE(body: any, extractChunk: (data: string) => StreamChunk | null): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            const chunk = extractChunk(data);
            if (chunk) yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private toAbortSignal(token: vscode.CancellationToken): AbortSignal {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    return controller.signal;
  }
}
