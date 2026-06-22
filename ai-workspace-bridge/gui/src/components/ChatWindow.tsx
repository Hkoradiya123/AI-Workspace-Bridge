import React, { useRef, useEffect } from 'react';
import { MessageBubble } from './MessageBubble';

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

interface ChatWindowProps {
  messages: Message[];
  isStreaming: boolean;
  streamContent: string;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({ messages, isStreaming, streamContent }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamContent]);

  return (
    <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center opacity-50 p-4">
          <div className="text-4xl mb-2">✨</div>
          <p>Welcome to AI Workspace Bridge.</p>
          <p className="text-sm mt-2">I can read your code, write files, and answer questions.</p>
        </div>
      )}
      
      {messages.map((msg, index) => (
        <MessageBubble key={index} role={msg.role} content={msg.content} />
      ))}
      
      {isStreaming && (
        <div className="flex justify-start my-2 mr-8">
          <div className="bg-editor-bg text-editor-fg rounded-r-lg rounded-bl-lg p-3 border border-focus w-full">
            <div className="font-bold text-xs mb-1 opacity-70">Assistant is typing...</div>
            <div className="text-vscode leading-relaxed whitespace-pre-wrap">
              {streamContent}
              <span className="inline-block w-2 h-4 ml-1 bg-button-bg animate-pulse"></span>
            </div>
          </div>
        </div>
      )}
      
      <div ref={bottomRef} />
    </div>
  );
};
