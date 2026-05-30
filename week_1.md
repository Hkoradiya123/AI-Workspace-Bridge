# Project: VS Code Custom Language Model Provider (Week 1 MVP)

## Objective

Build a production-quality VS Code extension that registers a custom Language Model Provider and appears inside the VS Code AI/Chat model picker.

The extension should act as a bridge between VS Code Chat and a local backend service.

Week 1 goal is ONLY:

* Register custom model provider
* Show model in model picker
* Open chat
* Send prompts
* Stream responses
* Display responses in VS Code chat
* Create clean architecture for future agent features

DO NOT implement file editing, terminal execution, browser automation, memory, or multi-file agents yet.

---

## Tech Stack

### Extension

* TypeScript
* VS Code Extension API
* VS Code Language Model APIs
* Node.js

### Development Tools

* npm
* esbuild
* TypeScript strict mode

---

## Project Structure

Create the following structure:

src/

* extension.ts
* provider/

  * ChatProvider.ts
  * StreamHandler.ts
* services/

  * BackendClient.ts
* types/

  * ChatTypes.ts
* utils/

  * Logger.ts

Root Files

* package.json
* tsconfig.json
* esbuild.js
* README.md
* .gitignore

---

## Extension Requirements

### Extension Name

AI Workspace Bridge

### Display Name

AI Workspace Bridge

### Model Name

Workspace Agent

### Description

Custom language model provider for VS Code chat.

---

## Architecture

VS Code Chat

↓

Workspace Agent Provider

↓

BackendClient

↓

Mock Response Service

For Week 1 use mock responses only.

No real AI provider yet.

---

## Functional Requirements

### Requirement 1

Extension loads successfully.

Acceptance Criteria:

* No startup errors
* No TypeScript errors
* No activation errors

---

### Requirement 2

Model Registration

Register a model named:

Workspace Agent

Acceptance Criteria:

* Appears in model picker
* User can select it
* User can switch back to other models

---

### Requirement 3

Prompt Handling

When user sends:

"Hello"

Provider receives:

"Hello"

Acceptance Criteria:

* Prompt captured correctly
* Logging confirms receipt

---

### Requirement 4

Streaming

Responses must stream token-by-token.

Example:

User:

Hello

Response stream:

Hello
from
Workspace
Agent

Acceptance Criteria:

* Streaming visible in chat
* No blocking UI
* Incremental updates

---

### Requirement 5

Backend Client

Create a backend abstraction.

Interface:

sendPrompt(prompt)

Returns streamed response.

For Week 1:

Return mock data.

Example responses:

"Hello from Workspace Agent"

"FastAPI is a modern Python web framework."

"SQLAlchemy is an ORM."

---

### Requirement 6

Logging

Create centralized logger.

Log:

* Extension activation
* Model registration
* Prompt received
* Stream started
* Stream finished
* Errors

Output:

VS Code Output Channel

Name:

AI Workspace Bridge

---

## Coding Standards

### TypeScript

* strict true
* no any
* use interfaces
* use async/await

### Architecture

* dependency injection where possible
* small classes
* single responsibility principle

### Error Handling

Never crash extension.

Wrap:

* registration
* streaming
* backend calls

with try/catch.

---

## Mock Provider Behavior

If prompt contains:

FastAPI

Return:

"FastAPI is a modern Python framework for building APIs."

If prompt contains:

SQLAlchemy

Return:

"SQLAlchemy provides ORM and database abstraction for Python."

Otherwise return:

"You asked: {prompt}"

Stream words one at a time.

Delay:

50ms per token.

---

## Future-Proof Interfaces

Design interfaces for future implementation.

Example:

IChatProvider

IBackendClient

IStreamHandler

Future implementations should be swappable without changing chat logic.

---

## Deliverables

Generate:

1. package.json
2. tsconfig.json
3. esbuild configuration
4. extension.ts
5. ChatProvider.ts
6. BackendClient.ts
7. StreamHandler.ts
8. Logger.ts
9. Types
10. README

Include complete code.

Do not provide pseudocode.

Provide production-ready implementation.

All files should compile successfully.

---

## Acceptance Test

After installation:

1. Open VS Code
2. Open Chat
3. Select Workspace Agent
4. Send:

Hello

Expected:

Hello from Workspace Agent

5. Send:

What is FastAPI?

Expected:

FastAPI is a modern Python framework for building APIs.

6. Response streams gradually.

7. No errors appear in logs.

Project is considered complete only if all acceptance tests pass.
