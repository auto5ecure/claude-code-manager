import { useState, useEffect, useRef } from 'react';

interface QuickCommandsProps {
  onRunCommand: (command: string) => void;
  onClose: () => void;
}

const COMMANDS = [
  { label: 'npm install', command: 'npm install', icon: '📦' },
  { label: 'npm run dev', command: 'npm run dev', icon: '▶' },
  { label: 'npm run build', command: 'npm run build', icon: '🔨' },
  { label: 'npm test', command: 'npm test', icon: '🧪' },
  { label: 'git status', command: 'git status', icon: '📊' },
  { label: 'git pull', command: 'git pull', icon: '⬇' },
  { label: 'git push', command: 'git push', icon: '⬆' },
  { label: 'git diff', command: 'git diff', icon: '📝' },
  { label: 'git log --oneline -10', command: 'git log --oneline -10', icon: '📜' },
  { label: 'ls -la', command: 'ls -la', icon: '📂' },
  { label: 'claude', command: 'claude', icon: '🤖' },
  { label: 'clear', command: 'clear', icon: '🧹' },
];

export default function QuickCommands({ onRunCommand, onClose }: QuickCommandsProps) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredCommands = COMMANDS.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(search.toLowerCase()) ||
      cmd.command.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        onRunCommand(filteredCommands[selectedIndex].command);
      } else if (search.trim()) {
        onRunCommand(search.trim());
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="quick-commands-overlay" onClick={onClose}>
      <div className="quick-commands-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="quick-commands-input"
          placeholder="Befehl eingeben oder suchen..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="quick-commands-list">
          {filteredCommands.map((cmd, index) => (
            <button
              key={cmd.command}
              className={`quick-command-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => onRunCommand(cmd.command)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="quick-command-icon">{cmd.icon}</span>
              <span className="quick-command-label">{cmd.label}</span>
              <span className="quick-command-hint">{cmd.command}</span>
            </button>
          ))}
          {filteredCommands.length === 0 && search.trim() && (
            <button
              className="quick-command-item selected"
              onClick={() => onRunCommand(search.trim())}
            >
              <span className="quick-command-icon">⚡</span>
              <span className="quick-command-label">Ausführen: {search}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
