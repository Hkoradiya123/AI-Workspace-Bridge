# AI Workspace Bridge

AI Workspace Bridge is a VS Code extension that registers a custom chat model provider and a chat participant named `@myagent`.

The extension can run in two modes:

- Mock mode when no ChatGPT token is configured.
- ChatGPT mode when a session token is saved through the command palette.

## Features

- Registers a VS Code language model provider.
- Adds the `@myagent` chat participant.
- Streams responses token-by-token into VS Code chat.
- Stores the ChatGPT session token securely with VS Code secrets.
- Uses Puppeteer to send prompts through a headless browser session.
- Falls back to mock responses if ChatGPT is not configured or the session fails.

## Commands

Open the VS Code command palette and run:

- `AI Workspace Bridge: Set ChatGPT Token`
- `AI Workspace Bridge: Clear ChatGPT Token`
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

## Enabling ChatGPT Mode

1. Sign in to ChatGPT in your browser.
2. Copy your ChatGPT session token from browser cookies.
3. In VS Code, run `AI Workspace Bridge: Set ChatGPT Token`.
4. Paste the token when prompted.
5. Run `AI Workspace Bridge: Check Status` to confirm configuration.

The token is stored in VS Code SecretStorage, not in project files.

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
