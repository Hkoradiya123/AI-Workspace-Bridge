import React, { useState } from 'react';

interface ToolbarProps {
  onListFiles: () => void;
  onSearch: (query: string) => void;
  onSettingsClick: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({ onListFiles, onSearch, onSettingsClick }) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      onSearch(searchQuery.trim());
      setSearchQuery('');
      setIsSearchOpen(false);
    }
  };

  return (
    <div className="flex flex-col bg-editor-bg border-b border-focus">
      <div className="flex flex-row justify-between items-center p-2">
        <div className="flex flex-row gap-2">
          <button 
            title="List Files"
            className="p-1 hover:bg-button-hover rounded text-editor-fg"
            onClick={onListFiles}
          >
            📁
          </button>
          <button 
            title="Search Workspace"
            className="p-1 hover:bg-button-hover rounded text-editor-fg"
            onClick={() => setIsSearchOpen(!isSearchOpen)}
          >
            🔍
          </button>
        </div>
        <button 
          title="Settings"
          className="p-1 hover:bg-button-hover rounded text-editor-fg"
          onClick={onSettingsClick}
        >
          ⚙️
        </button>
      </div>
      
      {isSearchOpen && (
        <form onSubmit={handleSearchSubmit} className="p-2 border-t border-focus flex flex-row gap-2">
          <input
            autoFocus
            type="text"
            placeholder="Search query..."
            className="flex-1 bg-input-bg text-input-fg border border-input-border p-1 text-vscode outline-none focus:border-focus rounded"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button 
            type="submit"
            className="bg-button-bg text-button-fg px-2 py-1 rounded hover:bg-button-hover"
            disabled={!searchQuery.trim()}
          >
            Go
          </button>
        </form>
      )}
    </div>
  );
};
