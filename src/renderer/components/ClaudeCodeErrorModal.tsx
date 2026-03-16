interface ClaudeCodeErrorModalProps {
  instructions: string;
  onClose: () => void;
  onRetry: () => void;
}

export default function ClaudeCodeErrorModal({
  instructions,
  onClose,
  onRetry,
}: ClaudeCodeErrorModalProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="claude-error-overlay" onClick={onClose}>
      <div className="claude-error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="claude-error-header">
          <span>Claude Code Installation</span>
          <button className="claude-error-close" onClick={onClose}>✕</button>
        </div>

        <div className="claude-error-content">
          <div className="claude-error-icon">⚠️</div>
          <h3>Claude Code ist nicht installiert</h3>

          <div className="claude-error-instructions">
            <pre>{instructions}</pre>
          </div>

          <div className="claude-error-quick-copy">
            <p>Schnellinstallation (in Terminal einfügen):</p>
            <div className="copy-buttons">
              <button
                className="copy-btn"
                onClick={() => copyToClipboard('brew install node && npm install -g @anthropic-ai/claude-code')}
                title="Kopieren"
              >
                📋 Mit Homebrew
              </button>
              <button
                className="copy-btn"
                onClick={() => copyToClipboard('npm install -g @anthropic-ai/claude-code')}
                title="Kopieren"
              >
                📋 Nur npm
              </button>
              <button
                className="copy-btn"
                onClick={() => copyToClipboard('npx @anthropic-ai/claude-code')}
                title="Kopieren"
              >
                📋 Mit npx (ohne Install)
              </button>
            </div>
          </div>
        </div>

        <div className="claude-error-footer">
          <button className="btn-cancel" onClick={onClose}>
            Schließen
          </button>
          <button className="btn-retry" onClick={onRetry}>
            ↻ Erneut prüfen
          </button>
        </div>
      </div>
    </div>
  );
}
