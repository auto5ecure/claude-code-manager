import { useState } from 'react';

interface CoworkSettingsModalProps {
  onClose: () => void;
  onImportCowork: () => Promise<void>;
  onExportCowork: () => Promise<void>;
  onImportDeployment: () => Promise<void>;
  onExportDeployment: () => Promise<void>;
}

export default function CoworkSettingsModal({
  onClose,
  onImportCowork,
  onExportCowork,
  onImportDeployment,
  onExportDeployment,
}: CoworkSettingsModalProps) {
  const [loading, setLoading] = useState<string | null>(null);

  async function handleAction(action: () => Promise<void>, name: string) {
    setLoading(name);
    try {
      await action();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="cowork-settings-modal-overlay" onClick={onClose}>
      <div className="cowork-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cowork-settings-header">
          <span>Coworking Einstellungen</span>
          <button className="cowork-settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="cowork-settings-content">
          {/* Cowork Repositories */}
          <div className="settings-group">
            <h3>Cowork Repositories</h3>
            <div className="settings-actions">
              <button
                className="settings-action-btn"
                onClick={() => handleAction(onImportCowork, 'import-cowork')}
                disabled={loading !== null}
              >
                <span className="action-icon">⬇</span>
                <span className="action-text">
                  {loading === 'import-cowork' ? 'Importiere...' : 'Importieren'}
                </span>
              </button>
              <button
                className="settings-action-btn"
                onClick={() => handleAction(onExportCowork, 'export-cowork')}
                disabled={loading !== null}
              >
                <span className="action-icon">⬆</span>
                <span className="action-text">
                  {loading === 'export-cowork' ? 'Exportiere...' : 'Exportieren'}
                </span>
              </button>
            </div>
          </div>

          {/* Deployment Configs */}
          <div className="settings-group">
            <h3>Deployment Konfigurationen</h3>
            <div className="settings-actions">
              <button
                className="settings-action-btn"
                onClick={() => handleAction(onImportDeployment, 'import-deploy')}
                disabled={loading !== null}
              >
                <span className="action-icon">🚀⬇</span>
                <span className="action-text">
                  {loading === 'import-deploy' ? 'Importiere...' : 'Importieren'}
                </span>
              </button>
              <button
                className="settings-action-btn"
                onClick={() => handleAction(onExportDeployment, 'export-deploy')}
                disabled={loading !== null}
              >
                <span className="action-icon">🚀⬆</span>
                <span className="action-text">
                  {loading === 'export-deploy' ? 'Exportiere...' : 'Exportieren'}
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="cowork-settings-footer">
          <button className="btn-close" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}
