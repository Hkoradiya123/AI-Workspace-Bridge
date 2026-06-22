import { useEffect, useState, useCallback, useRef } from 'react';

// Singleton for VS Code API
let vscodeApi: any = null;
try {
  // @ts-ignore
  vscodeApi = acquireVsCodeApi();
} catch (e) {
  // Mock for browser testing
  vscodeApi = {
    postMessage: (msg: any) => console.log('Mock postMessage:', msg)
  };
}

export interface WebviewMessage {
  type: string;
  [key: string]: any;
}

export function useVSCodeMessenger() {
  const [messages, setMessages] = useState<WebviewMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamChunkBuffer = useRef('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data as WebviewMessage;
      
      switch (message.type) {
        case 'streamStart':
          setIsStreaming(true);
          streamChunkBuffer.current = '';
          break;
        case 'streamChunk':
          streamChunkBuffer.current += message.chunk;
          setMessages(prev => [
            ...prev.filter(m => m.type !== 'streamUpdate'),
            { type: 'streamUpdate', content: streamChunkBuffer.current }
          ]);
          break;
        case 'streamEnd': {
          const finalContent = streamChunkBuffer.current;
          streamChunkBuffer.current = '';
          setIsStreaming(false);
          setMessages(prev => [
            ...prev.filter(m => m.type !== 'streamUpdate'),
            { type: 'assistantMessage', content: finalContent }
          ]);
          break;
        }
        default:
          setMessages(prev => [...prev, message]);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const sendMessage = useCallback((message: WebviewMessage) => {
    vscodeApi.postMessage(message);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { 
    sendMessage, 
    messages, 
    isStreaming,
    streamContent: streamChunkBuffer.current,
    clearMessages 
  };
}
