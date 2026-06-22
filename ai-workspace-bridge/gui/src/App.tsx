import { useState, useEffect } from 'react';
import { useVSCodeMessenger } from './hooks/useVSCodeMessenger';
import { Toolbar } from './components/Toolbar';
import { ChatWindow } from './components/ChatWindow';
import { InputBar } from './components/InputBar';

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export default function App() {
  const { sendMessage, messages: rawMessages, isStreaming, streamContent } = useVSCodeMessenger();
  const [showSettings, setShowSettings] = useState(false);
  
  // Settings state
  const [provider, setProvider] = useState('browser');
  const [model, setModel] = useState('gpt-4o');
  const [apiKey, setApiKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  
  // Transform WebviewMessage to our Message type
  const [chatHistory, setChatHistory] = useState<Message[]>([]);

  useEffect(() => {
    // Check initial status
    sendMessage({ type: 'getStatus' });
  }, [sendMessage]);

  useEffect(() => {
    // Process new messages
    if (rawMessages.length > 0) {
      const latest = rawMessages[rawMessages.length - 1];
      if (latest.type === 'assistantMessage') {
        setChatHistory(prev => [...prev, { role: 'assistant', content: latest.content }]);
      } else if (latest.type === 'toolResult') {
        setChatHistory(prev => [...prev, { role: 'tool', content: latest.content }]);
      } else if (latest.type === 'status') {
        setProvider(latest.status?.provider || 'browser');
        setModel(latest.status?.model || 'gpt-4o');
      } else if (latest.type === 'restoreHistory') {
        setChatHistory(latest.history);
      }
    }
  }, [rawMessages]);

  const handleSend = (text: string) => {
    setChatHistory(prev => [...prev, { role: 'user', content: text }]);
    sendMessage({ type: 'sendPrompt', prompt: text });
  };

  const handleSaveSettings = () => {
    sendMessage({ type: 'saveSettings', config: { provider, model, apiKey } });
    setShowSettings(false);
  };

  return (
    <div className="flex flex-col h-screen bg-editor-bg text-editor-fg font-vscode">
      <Toolbar 
        onListFiles={() => sendMessage({ type: 'listFiles' })}
        onSearch={(query) => sendMessage({ type: 'searchWorkspace', query })}
        onSettingsClick={() => setShowSettings(!showSettings)}
      />
      
      {showSettings && (
        <div className="p-3 bg-input-bg border-b border-focus flex flex-col gap-2">
          <h3 className="font-bold text-sm mb-1">Settings</h3>
          <div className="flex flex-col gap-1 text-xs">
            <label>Provider</label>
            <select 
              value={provider} 
              onChange={e => setProvider(e.target.value)}
              className="bg-editor-bg border border-input-border p-1 rounded text-editor-fg"
            >
              <option value="browser">Browser (Puppeteer)</option>
              <option value="openai">OpenAI API</option>
              <option value="anthropic">Anthropic API</option>
            </select>
          </div>
          
          <div className="flex flex-col gap-1 text-xs mt-1">
            <label>Model</label>
            <input 
              type="text" 
              value={model} 
              onChange={e => setModel(e.target.value)}
              className="bg-editor-bg border border-input-border p-1 rounded text-editor-fg"
            />
          </div>
          
          {provider !== 'browser' ? (
            <div className="flex flex-col gap-1 text-xs mt-1">
              <label>API Key</label>
              <input 
                type="password" 
                value={apiKey} 
                onChange={e => setApiKey(e.target.value)}
                placeholder="Leave blank to keep existing"
                className="bg-editor-bg border border-input-border p-1 rounded text-editor-fg"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1 text-xs mt-1">
              <label>ChatGPT Session Token</label>
              <div className="flex gap-1">
                <input 
                  type="password" 
                  value={sessionToken} 
                  onChange={e => setSessionToken(e.target.value)}
                  placeholder="Paste __Secure-next-auth.session-token"
                  className="flex-1 bg-editor-bg border border-input-border p-1 rounded text-editor-fg"
                />
                <button 
                  onClick={() => {
                    if (sessionToken) {
                      sendMessage({ type: 'setSessionToken', token: sessionToken });
                      setSessionToken('');
                    }
                  }}
                  className="bg-button-bg text-button-fg px-2 py-1 rounded hover:bg-button-hover"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          
          <div className="flex justify-end mt-2">
            <button 
              onClick={handleSaveSettings}
              className="bg-button-bg text-button-fg px-3 py-1 rounded text-xs hover:bg-button-hover"
            >
              Save
            </button>
          </div>
        </div>
      )}
      
      <ChatWindow 
        messages={chatHistory} 
        isStreaming={isStreaming} 
        streamContent={streamContent} 
      />
      
      <InputBar 
        onSend={handleSend} 
        isStreaming={isStreaming} 
      />
    </div>
  );
}
