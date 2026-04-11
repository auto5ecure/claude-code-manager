import type { CoworkRepository } from '../../shared/types';

interface CoworkRepoSettingsModalProps {
  repo: CoworkRepository;
  onClose: () => void;
  onSave: (repoId: string, settings: Record<string, never>) => void;
}

export default function CoworkRepoSettingsModal({
  repo,
  onClose,
  onSave,
}: CoworkRepoSettingsModalProps) {
  function handleSave() {
    onSave(repo.id, {});
    onClose();
  }

  return (
    <div className="cowork-repo-settings-modal-overlay" onClick={onClose}>
      <div className="cowork-repo-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cowork-repo-settings-header">
          <span>Einstellungen: {repo.name}</span>
          <button className="cowork-repo-settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="cowork-repo-settings-content">
          {/* Repository Info */}
          <div className="settings-section">
            <h3>Repository</h3>
            <div className="settings-info">
              <div className="info-row">
                <span className="info-label">Pfad:</span>
                <span className="info-value">{repo.localPath}</span>
              </div>
              <div className="info-row">
                <span className="info-label">GitHub:</span>
                <span className="info-value">{repo.githubUrl}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Branch:</span>
                <span className="info-value">{repo.branch}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="cowork-repo-settings-footer">
          <button className="btn-cancel" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
