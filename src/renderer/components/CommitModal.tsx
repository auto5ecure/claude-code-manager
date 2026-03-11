import { useState } from 'react';
import type { CoworkRepository } from '../../shared/types';

interface CommitModalProps {
  repository: CoworkRepository;
  changedFiles: string[];
  onCommitPush: (message: string) => void;
  onDiscard: () => void;
  onLater: () => void;
}

export default function CommitModal({
  repository,
  changedFiles,
  onCommitPush,
  onDiscard,
  onLater,
}: CommitModalProps) {
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCommitPush() {
    if (!message.trim()) {
      setError('Commit-Message ist erforderlich');
      return;
    }

    setCommitting(true);
    setError(null);

    try {
      const result = await window.electronAPI?.coworkCommitPush(
        repository.localPath,
        message.trim(),
        repository.remote,
        repository.branch
      );
      if (result?.success) {
        await window.electronAPI?.updateCoworkLastSync(repository.id);
        onCommitPush(message.trim());
      } else {
        setError(result?.error || 'Commit & Push fehlgeschlagen');
        setCommitting(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setCommitting(false);
    }
  }

  return (
    <div className="commit-overlay" onClick={onLater}>
      <div className="commit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="commit-header">
          <span>Änderungen committen</span>
          <button className="commit-close" onClick={onLater}>✕</button>
        </div>
        <div className="commit-content">
          <div className="commit-repo-info">
            <span className="commit-repo-icon">📁</span>
            <div className="commit-repo-details">
              <span className="commit-repo-name">{repository.name}</span>
              <span className="commit-repo-branch">{repository.remote}/{repository.branch}</span>
            </div>
          </div>

          <div className="commit-files">
            <span className="commit-files-title">
              {changedFiles.length} geänderte Datei{changedFiles.length !== 1 ? 'en' : ''}:
            </span>
            <ul className="commit-files-list">
              {changedFiles.slice(0, 10).map((file) => (
                <li key={file}>{file}</li>
              ))}
              {changedFiles.length > 10 && (
                <li className="more">...und {changedFiles.length - 10} weitere</li>
              )}
            </ul>
          </div>

          <div className="commit-message-group">
            <label htmlFor="commit-message">Commit Message</label>
            <textarea
              id="commit-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Beschreibe deine Änderungen..."
              rows={3}
              autoFocus
            />
          </div>

          {error && <div className="commit-error">{error}</div>}
        </div>

        <div className="commit-footer">
          <button className="btn-discard" onClick={onDiscard}>
            Verwerfen
          </button>
          <button className="btn-later" onClick={onLater}>
            Später
          </button>
          <button
            className="btn-commit"
            onClick={handleCommitPush}
            disabled={committing || !message.trim()}
          >
            {committing ? 'Committing...' : 'Commit & Push'}
          </button>
        </div>
      </div>
    </div>
  );
}
