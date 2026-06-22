export const CHATGPT_TOKEN_SECRET_KEY = "chatgpt-token";

export interface ChatGPTClientStatus {
  hasToken: boolean;
  isBrowserReady: boolean;
}

export interface ChatGPTSelectors {
  promptInput: string;
  assistantMessage: string;
  stopGeneratingButton: string;
  sendButton: string;
}
