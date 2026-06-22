import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ role, content }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  if (role === 'user') {
    return (
      <div className="flex justify-end my-2 ml-8">
        <div className="bg-button-bg text-button-fg rounded-l-lg rounded-br-lg p-3 whitespace-pre-wrap word-break">
          {content}
        </div>
      </div>
    );
  }

  if (role === 'tool') {
    const isError = content.startsWith('Error:');
    return (
      <div className="flex flex-col my-2 mx-2">
        <button 
          onClick={() => setIsExpanded(!isExpanded)}
          className={`text-left p-2 rounded text-xs flex flex-row justify-between items-center bg-input-bg text-input-fg border ${isError ? 'border-red-500' : 'border-input-border'}`}
        >
          <span className="font-bold">🔧 Tool Result</span>
          <span>{isExpanded ? '▼' : '▶'}</span>
        </button>
        {isExpanded && (
          <pre className="bg-input-bg border-x border-b border-input-border p-2 text-xs overflow-x-auto whitespace-pre-wrap rounded-b font-vscode mt-0">
            {content}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-start my-2 mr-8">
      <div className="bg-editor-bg text-editor-fg rounded-r-lg rounded-bl-lg p-3 word-break border border-focus w-full overflow-x-hidden">
        <div className="font-bold text-xs mb-2 opacity-70">Assistant</div>
        <div className="text-vscode leading-relaxed markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ node, inline, className, children, ...props }: any) {
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                const codeString = String(children).replace(/\n$/, '');
                
                if (!inline) {
                  return (
                    <div className="relative my-4 rounded-md overflow-hidden border border-input-border">
                      <div className="flex justify-between items-center bg-input-bg px-4 py-1 border-b border-input-border text-xs">
                        <span className="opacity-70 font-vscode">{language || 'text'}</span>
                        <button
                          onClick={() => handleCopy(codeString)}
                          className="hover:opacity-70 transition-opacity p-1"
                          title="Copy Code"
                        >
                          {copiedCode === codeString ? (
                            <Check size={14} className="text-green-500" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                      <SyntaxHighlighter
                        {...props}
                        style={vscDarkPlus as any}
                        language={language}
                        PreTag="div"
                        customStyle={{ margin: 0, borderRadius: 0, fontSize: '0.85rem' }}
                      >
                        {codeString}
                      </SyntaxHighlighter>
                    </div>
                  );
                }
                
                return (
                  <code {...props} className="bg-input-bg text-input-fg px-1.5 py-0.5 rounded font-vscode text-xs border border-input-border">
                    {children}
                  </code>
                );
              },
              p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="list-disc pl-5 mb-3">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-5 mb-3">{children}</ol>,
              li: ({ children }) => <li className="mb-1">{children}</li>,
              h1: ({ children }) => <h1 className="text-xl font-bold mb-3 mt-4">{children}</h1>,
              h2: ({ children }) => <h2 className="text-lg font-bold mb-2 mt-3">{children}</h2>,
              h3: ({ children }) => <h3 className="text-md font-bold mb-2 mt-2">{children}</h3>,
              blockquote: ({ children }) => <blockquote className="border-l-4 border-focus pl-3 py-1 my-3 opacity-80 bg-input-bg rounded-r">{children}</blockquote>,
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
