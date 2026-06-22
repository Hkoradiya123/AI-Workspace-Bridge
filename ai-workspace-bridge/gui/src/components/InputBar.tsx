import React, { useState, useRef, useEffect } from 'react';

interface InputBarProps {
  onSend: (text: string) => void;
  isStreaming: boolean;
}

const SLASH_COMMANDS = [
  { command: '/sysprompt', description: 'Force re-inject system prompt' }
];

export const InputBar: React.FC<InputBarProps> = ({ onSend, isStreaming }) => {
  const [text, setText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  const filteredCommands = text.startsWith('/') 
    ? SLASH_COMMANDS.filter(c => c.command.toLowerCase().startsWith(text.split(' ')[0].toLowerCase()))
    : [];

  useEffect(() => {
    adjustHeight();
    
    if (text.startsWith('/') && !text.includes(' ') && filteredCommands.length > 0) {
      setShowDropdown(true);
      if (selectedIndex >= filteredCommands.length) {
        setSelectedIndex(0);
      }
    } else {
      setShowDropdown(false);
    }
  }, [text]);

  const handleSubmit = () => {
    if (text.trim() && !isStreaming) {
      onSend(text.trim());
      setText('');
      setShowDropdown(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleSelectCommand = (cmd: string) => {
    setText(cmd + ' ');
    setShowDropdown(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex].command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDropdown(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      setText('');
    }
  };

  return (
    <div className="flex flex-col p-2 bg-editor-bg border-t border-focus relative">
      {showDropdown && (
        <div className="absolute bottom-full left-2 mb-1 w-[90%] bg-input-bg border border-focus rounded shadow-lg overflow-hidden z-50">
          {filteredCommands.map((cmd, index) => (
            <div 
              key={cmd.command}
              onClick={() => handleSelectCommand(cmd.command)}
              className={`p-2 cursor-pointer flex justify-between items-center text-xs font-vscode ${index === selectedIndex ? 'bg-button-bg text-button-fg' : 'text-input-fg hover:bg-editor-bg'}`}
            >
              <span className="font-bold">{cmd.command}</span>
              <span className="opacity-70">{cmd.description}</span>
            </div>
          ))}
        </div>
      )}
      
      {text.length > 500 && (
        <div className="text-xs text-gray-500 mb-1 text-right">
          {text.length} chars
        </div>
      )}
      <div className="flex flex-row items-end gap-2 relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message or '/' for commands..."
          className="flex-1 bg-input-bg text-input-fg border border-input-border rounded p-2 text-vscode resize-none overflow-y-auto focus:border-focus outline-none"
          rows={1}
          style={{ minHeight: '36px', maxHeight: '120px' }}
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || isStreaming}
          className={`px-3 py-2 rounded font-bold ${!text.trim() || isStreaming ? 'bg-gray-500 text-gray-300 cursor-not-allowed' : 'bg-button-bg text-button-fg hover:bg-button-hover'}`}
          title="Send (Enter)"
        >
          ▶
        </button>
      </div>
    </div>
  );
};
