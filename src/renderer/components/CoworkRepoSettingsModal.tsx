import { useState, useEffect } from 'react';
import type { CoworkRepository } from '../../shared/types';

interface CoworkRepoSettingsModalProps {
  repo: CoworkRepository;
  onClose: () => void;
  onSave: (repoId: string, settings: { wikiEnabled: boolean; wikiVaultPath: string | null }) => void;
}

export default function CoworkRepoSettingsModal({
  repo,
  onClose,
  onSave,
}: CoworkRepoSettingsModalProps) {
  const [wikiEnabled, setWikiEnabled] = useState(repo.wikiEnabled || false);
  const [wikiVaultPath, setWikiVaultPath] = useState(repo.wikiVaultPath || '');
  const [hasChanges, setHasChanges] = useState(false);
  const [detectingVault, setDetectingVault] = useState(false);
  const [updatingWiki, setUpdatingWiki] = useState(false);
  const [wikiUpdateResult, setWikiUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    setWikiEnabled(repo.wikiEnabled || false);
    setWikiVaultPath(repo.wikiVaultPath || '');
    setHasChanges(false);
  }, [repo]);

  function handleWikiEnabledChange(enabled: boolean) {
    setWikiEnabled(enabled);
    setHasChanges(true);
  }

  function handleVaultPathChange(path: string) {
    setWikiVaultPath(path);
    setHasChanges(true);
  }

  async function handleDetectVault() {
    setDetectingVault(true);
    try {
      const result = await (window as any).electronAPI?.detectVaultPath(repo.localPath);
      if (result?.vaultPath) {
        setWikiVaultPath(result.vaultPath);
        setHasChanges(true);
      } else {
        alert('Kein Obsidian Vault gefunden im Pfad-Baum');
      }
    } catch (err) {
      alert(`Fehler: ${(err as Error).message}`);
    } finally {
      setDetectingVault(false);
    }
  }

  async function handleBrowseVault() {
    try {
      const result = await (window as any).electronAPI?.showOpenDialog({
        title: 'Obsidian Vault auswählen',
        properties: ['openDirectory']
      });
      if (result?.filePaths && result.filePaths.length > 0) {
        setWikiVaultPath(result.filePaths[0]);
        setHasChanges(true);
      }
    } catch (err) {
      alert(`Fehler: ${(err as Error).message}`);
    }
  }

  async function handleUpdateWiki() {
    setUpdatingWiki(true);
    setWikiUpdateResult(null);
    try {
      const result = await (window as any).electronAPI?.updateCoworkWiki(repo.id);
      if (result?.success) {
        setWikiUpdateResult({ success: true, message: `Wiki aktualisiert: ${result.path || 'OK'}` });
      } else {
        setWikiUpdateResult({ success: false, message: result?.error || 'Unbekannter Fehler' });
      }
    } catch (err) {
      setWikiUpdateResult({ success: false, message: (err as Error).message });
    } finally {
      setUpdatingWiki(false);
    }
  }

  function handleSave() {
    onSave(repo.id, {
      wikiEnabled,
      wikiVaultPath: wikiVaultPath || null
    });
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

          {/* Obsidian Wiki */}
          <div className="settings-section">
            <h3>🔮 Obsidian Wiki</h3>
            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={wikiEnabled}
                  onChange={(e) => handleWikiEnabledChange(e.target.checked)}
                />
                <span>Wiki Integration aktivieren</span>
              </label>
              <span className="field-hint">Automatische Wiki-Updates bei Session-Ende</span>
            </div>

            {wikiEnabled && (
              <>
                <div className="settings-field">
                  <label>Obsidian Vault Pfad</label>
                  <div className="input-with-buttons">
                    <input
                      type="text"
                      value={wikiVaultPath}
                      onChange={(e) => handleVaultPathChange(e.target.value)}
                      placeholder="/Users/.../vault"
                    />
                    <button
                      type="button"
                      className="input-btn"
                      onClick={handleDetectVault}
                      disabled={detectingVault}
                      title="Vault automatisch erkennen"
                    >
                      {detectingVault ? '...' : '🔍'}
                    </button>
                    <button
                      type="button"
                      className="input-btn"
                      onClick={handleBrowseVault}
                      title="Vault manuell auswählen"
                    >
                      📁
                    </button>
                  </div>
                  <span className="field-hint">
                    Das Verzeichnis mit dem .obsidian Ordner
                  </span>
                </div>

                {wikiVaultPath && (
                  <div className="wiki-preview">
                    <span className="preview-label">Wiki-Pfad:</span>
                    <span className="preview-value">{wikiVaultPath}/Wiki/Projekte/{repo.name}.md</span>
                  </div>
                )}

                {/* Wiki Aktualisieren Button */}
                {repo.wikiEnabled && repo.wikiVaultPath && (
                  <div className="settings-field wiki-update-section">
                    <button
                      type="button"
                      className="btn-wiki-update"
                      onClick={handleUpdateWiki}
                      disabled={updatingWiki}
                    >
                      {updatingWiki ? '⏳ Aktualisiere...' : '🔄 Wiki jetzt aktualisieren'}
                    </button>
                    {wikiUpdateResult && (
                      <div className={`wiki-update-result ${wikiUpdateResult.success ? 'success' : 'error'}`}>
                        {wikiUpdateResult.success ? '✅' : '❌'} {wikiUpdateResult.message}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="cowork-repo-settings-footer">
          <button className="btn-cancel" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!hasChanges || (wikiEnabled && !wikiVaultPath)}
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
