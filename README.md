# AI Workspace Bridge

AI Workspace Bridge is a VS Code extension that registers a custom chat model provider and a chat participant named `@myagent`.

The extension can run in two modes:

- Mock mode when no ChatGPT token is configured.
- ChatGPT mode when a session token is saved through the command palette.

## Features

- Registers a VS Code language model provider.
- Adds the `@myagent` chat participant.
- Streams responses token-by-token into VS Code chat.
- Provides local workspace tools for listing, reading, searching, and guarded file writes.
- Stores the ChatGPT session token securely with VS Code secrets.
- Uses Puppeteer to send prompts through a visible browser session.
- Falls back to mock responses if ChatGPT is not configured or the session fails.

## Commands

Open the VS Code command palette and run:

- `AI Workspace Bridge: Set ChatGPT Token`
- `AI Workspace Bridge: Clear ChatGPT Token`
- `AI Workspace Bridge: Reset ChatGPT Browser Profile`
- `AI Workspace Bridge: Open ChatGPT Browser`
- `AI Workspace Bridge: Check Status`

## Setup

Install dependencies:

```bash
npm install
```

Build the extension:

```bash
npm run build
```

Run TypeScript checks:

```bash
npm run lint
```

Start a watch build:

```bash
npm run watch
```

## Running In VS Code

1. Open this folder in VS Code.
2. Press `F5` to launch the extension development host.
3. Open Chat in the extension host window.
4. Use `@myagent` to send a prompt.

Without a token, the extension responds with mock messages.

## Workspace Agent Tools

`@myagent` can run a few local workspace tools directly:

```text
@myagent agent help
@myagent agent context
@myagent /sysprompt
@myagent list files
@myagent summarize project
@myagent read all files and tell me
@myagent read file src/services/BackendClient.ts
@myagent search BackendClient
@myagent write file notes/example.txt: hello from the agent
```

`agent context` shows the local tool manifest, workspace access, safety limits, and whether MCP/API integrations are available.

`/sysprompt` resends the full ChatGPT tool/system prompt into the visible ChatGPT browser conversation.

Write actions ask for confirmation before changing files.

When ChatGPT browser mode is working, the extension also sends ChatGPT a tool manifest and asks it to use a strict protocol:

```text
TOOL_CALL {"tool":"readFile","args":{"filePath":"src/extension.ts"}}
```

The extension executes the requested VS Code tool locally, sends the result back to ChatGPT as `TOOL_RESULT`, and returns ChatGPT's final answer in VS Code chat.

## Enabling ChatGPT Mode

1. In VS Code, run `AI Workspace Bridge: Open ChatGPT Browser`.
2. Log in to ChatGPT in the opened Chromium window.
3. Complete any Cloudflare or account verification screens.
4. Send another `@myagent` prompt from VS Code.

If the browser keeps opening in a bad logged-out state, run `AI Workspace Bridge: Reset ChatGPT Browser Profile`, then open the ChatGPT browser again and log in manually.

You can also run `AI Workspace Bridge: Set ChatGPT Token`, but ChatGPT often needs more than one session cookie. The visible browser login is usually more reliable.

The token is stored in VS Code SecretStorage, not in project files. The browser login profile is stored in VS Code global extension storage.

## Project Structure

```text
src/
  extension.ts                  Extension activation and command registration
  StreamHandler.ts              Streaming helpers for chat responses
  provider/ChatProvider.ts      VS Code language model provider
  services/BackendClient.ts     Mock/real backend selection
  services/ChatGPTClient.ts     Puppeteer ChatGPT client and token handling
  types/ChatTypes.ts            VS Code chat provider interfaces
  types/ChatGPTTypes.ts         ChatGPT integration types
  utils/Logger.ts               Output channel logger
```

## Notes

This integration relies on ChatGPT web UI selectors and session cookies, so it can break if the ChatGPT website changes. If real ChatGPT mode fails, the extension logs the error and falls back to mock mode.
