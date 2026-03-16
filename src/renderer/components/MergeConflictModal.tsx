import { useState } from 'react';
import type { MergeConflict } from '../../shared/types';

interface MergeConflictModalProps {
  conflicts: MergeConflict[];
  repoPath: string;
  onResolved: () => void;
  onCancel: () => void;
}

export default function MergeConflictModal({
  conflicts,
  repoPath,
  onResolved,
  onCancel,
}: MergeConflictModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, 'local' | 'remote'>>({});

  const currentConflict = conflicts[currentIndex];
  const allResolved = Object.keys(resolutions).length === conflicts.length;

  async function handleResolve(choice: 'local' | 'remote') {
    setResolutions((prev) => ({
      ...prev,
      [currentConflict.file]: choice,
    }));

    // Apply the resolution
    const content = choice === 'local' ? currentConflict.localContent : currentConflict.remoteContent;
    await window.electronAPI?.resolveConflict(repoPath, currentConflict.file, content);

    // Move to next or finish
    if (currentIndex < conflicts.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }

  async function handleOpenInEditor() {
    // Write both versions with markers for manual editing
    const markedContent = `<<<<<<< LOKAL (Deine Version)
${currentConflict.localContent}
=======
${currentConflict.remoteContent}
>>>>>>> REMOTE (Kollegen-Version)`;

    await window.electronAPI?.resolveConflict(repoPath, currentConflict.file, markedContent);

    // Open in default editor
    const filePath = `${repoPath}/${currentConflict.file}`;
    await window.electronAPI?.openInEditor(filePath);
  }

  async function handleFinish() {
    setResolving(true);
    onResolved();
  }

  function getFileIcon(filename: string): string {
    if (filename.endsWith('.json')) return '{ }';
    if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'TS';
    if (filename.endsWith('.js') || filename.endsWith('.jsx')) return 'JS';
    if (filename.endsWith('.css')) return '#';
    if (filename.endsWith('.md')) return 'MD';
    return '📄';
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="merge-conflict-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>⚠️ Merge-Konflikte</span>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <div className="merge-conflict-content">
          <div className="conflict-progress">
            Konflikt {currentIndex + 1} von {conflicts.length}
            {resolutions[currentConflict.file] && (
              <span className="resolved-badge">
                ✓ {resolutions[currentConflict.file] === 'local' ? 'Lokal' : 'Remote'}
              </span>
            )}
          </div>

          <div className="conflict-file">
            <span className="file-icon">{getFileIcon(currentConflict.file)}</span>
            <span className="file-name">{currentConflict.file}</span>
          </div>

          <div className="conflict-diff">
            <div className="diff-panel local">
              <div className="diff-header">
                <span className="diff-label">LOKAL</span>
                <span className="diff-desc">Deine Version</span>
              </div>
              <pre className="diff-content">{currentConflict.localContent.slice(0, 1000)}
                {currentConflict.localContent.length > 1000 && '\n... (gekürzt)'}
              </pre>
            </div>

            <div className="diff-panel remote">
              <div className="diff-header">
                <span className="diff-label">REMOTE</span>
                <span className="diff-desc">Kollegen-Version</span>
              </div>
              <pre className="diff-content">{currentConflict.remoteContent.slice(0, 1000)}
                {currentConflict.remoteContent.length > 1000 && '\n... (gekürzt)'}
              </pre>
            </div>
          </div>

          <div className="conflict-actions">
            <button
              className={`conflict-btn local ${resolutions[currentConflict.file] === 'local' ? 'selected' : ''}`}
              onClick={() => handleResolve('local')}
            >
              Lokal behalten
            </button>
            <button
              className={`conflict-btn remote ${resolutions[currentConflict.file] === 'remote' ? 'selected' : ''}`}
              onClick={() => handleResolve('remote')}
            >
              Remote übernehmen
            </button>
            <button className="conflict-btn editor" onClick={handleOpenInEditor}>
              In Editor öffnen
            </button>
          </div>

          <div className="conflict-navigation">
            <button
              className="nav-btn"
              onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
              disabled={currentIndex === 0}
            >
              ← Zurück
            </button>

            <div className="conflict-dots">
              {conflicts.map((_, i) => (
                <span
                  key={i}
                  className={`dot ${i === currentIndex ? 'active' : ''} ${resolutions[conflicts[i].file] ? 'resolved' : ''}`}
                  onClick={() => setCurrentIndex(i)}
                />
              ))}
            </div>

            {currentIndex < conflicts.length - 1 ? (
              <button
                className="nav-btn"
                onClick={() => setCurrentIndex(currentIndex + 1)}
              >
                Weiter →
              </button>
            ) : (
              <button
                className="nav-btn finish"
                onClick={handleFinish}
                disabled={!allResolved || resolving}
              >
                {resolving ? 'Wird angewendet...' : 'Fertig'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
