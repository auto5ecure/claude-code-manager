import { useState, useEffect } from 'react';
import type { Project } from './App';

interface ProjectInfoModalProps {
  project: Project;
  onClose: () => void;
  onProjectUpdated?: () => void;
}

interface ProjectFiles {
  claudeMd: { exists: boolean; size: number };
  contextMd: { exists: boolean; size: number };
  decisionsMd: { exists: boolean; size: number };
  statusMd: { exists: boolean; size: number };
  tasksDir: { exists: boolean; count: number };
}

interface ProjectSettings {
  autoAccept?: boolean;  // Legacy support
  unleashed?: boolean;
}

export default function ProjectInfoModal({ project, onClose, onProjectUpdated }: ProjectInfoModalProps) {
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [unleashed, setUnleashed] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [updatingPath, setUpdatingPath] = useState(false);

  // Wiki integration state
  const [wikiProjectEnabled, setWikiProjectEnabled] = useState(false);
  const [wikiVaultIndexEnabled, setWikiVaultIndexEnabled] = useState(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [savingWiki, setSavingWiki] = useState(false);
  const [updatingWiki, setUpdatingWiki] = useState(false);
  const [wikiUpdateResult, setWikiUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  const projectExists = project.exists !== false;

  useEffect(() => {
    loadProjectFiles();
    loadProjectSettings();
    loadWikiSettings();
    detectVault();
    setWikiUpdateResult(null);
  }, [project]);

  async function loadWikiSettings() {
    try {
      const settings = await window.electronAPI?.getWikiSettings(project.id);
      if (settings) {
        // Migrate from old createVaultPage/autoUpdateVaultIndex to new names
        setWikiProjectEnabled(settings.wikiProjectEnabled ?? settings.createVaultPage ?? false);
        setWikiVaultIndexEnabled(settings.wikiVaultIndexEnabled ?? settings.autoUpdateVaultIndex ?? false);
      }
    } catch (err) {
      console.error('Failed to load wiki settings:', err);
    }
  }

  async function detectVault() {
    try {
      const detected = await window.electronAPI?.detectVaultPath(project.path);
      setVaultPath(detected || null);
    } catch (err) {
      console.error('Failed to detect vault path:', err);
    }
  }

  async function loadProjectFiles() {
    setLoading(true);
    try {
      const info = await window.electronAPI?.getProjectFiles(project.path);
      setFiles(info || null);
    } catch (err) {
      console.error('Failed to load project files:', err);
    }
    setLoading(false);
  }

  async function loadProjectSettings() {
    try {
      const settings = await window.electronAPI?.getProjectSettings(project.id) as ProjectSettings | null;
      if (settings) {
        // Support both old 'autoAccept' and new 'unleashed' keys
        setUnleashed(settings.unleashed ?? settings.autoAccept ?? false);
      }
    } catch (err) {
      console.error('Failed to load project settings:', err);
    }
  }

  async function handleUnleashedChange(checked: boolean) {
    setUnleashed(checked);
    setSavingSettings(true);
    try {
      await window.electronAPI?.saveProjectSettings(project.id, { unleashed: checked });
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
    setSavingSettings(false);
  }

  async function handleWikiProjectToggle(checked: boolean) {
    setWikiProjectEnabled(checked);
    setSavingWiki(true);
    try {
      await window.electronAPI?.saveWikiSettings(project.id, {
        wikiProjectEnabled: checked,
        wikiVaultIndexEnabled,
        vaultPath: vaultPath || undefined,
      });
    } catch (err) {
      console.error('Failed to save wiki settings:', err);
    }
    setSavingWiki(false);
  }

  async function handleWikiVaultIndexToggle(checked: boolean) {
    setWikiVaultIndexEnabled(checked);
    setSavingWiki(true);
    try {
      await window.electronAPI?.saveWikiSettings(project.id, {
        wikiProjectEnabled,
        wikiVaultIndexEnabled: checked,
        vaultPath: vaultPath || undefined,
      });
    } catch (err) {
      console.error('Failed to save wiki settings:', err);
    }
    setSavingWiki(false);
  }

  async function handleUpdateWiki() {
    setUpdatingWiki(true);
    setWikiUpdateResult(null);
    try {
      const result = await window.electronAPI?.updateProjectWiki(project.path, project.id);
      if (result?.success) {
        setWikiUpdateResult({ success: true, message: result.message || 'Wiki aktualisiert' });
      } else {
        setWikiUpdateResult({ success: false, message: result?.error || 'Unbekannter Fehler' });
      }
    } catch (err) {
      setWikiUpdateResult({ success: false, message: (err as Error).message });
    } finally {
      setUpdatingWiki(false);
    }
  }

  async function handleUpdatePath() {
    setUpdatingPath(true);
    try {
      const newPath = await window.electronAPI?.selectNewProjectPath();
      if (newPath) {
        const result = await window.electronAPI?.updateProjectPath(project.path, newPath);
        if (result?.success) {
          onProjectUpdated?.();
          onClose();
        } else {
          alert(result?.error || 'Fehler beim Aktualisieren des Pfads');
        }
      }
    } catch (err) {
      console.error('Failed to update path:', err);
    }
    setUpdatingPath(false);
  }

  function formatSize(bytes: number): string {
    if (bytes === 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return (
    <div className="project-info-overlay" onClick={onClose}>
      <div className="project-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="project-info-header">
          <div className="project-info-title">
            <span className={`project-info-type ${project.type}`}>
              {project.type === 'tools' ? 'T' : 'P'}
            </span>
            <span>{project.name}</span>
          </div>
          <button className="project-info-close" onClick={onClose}>✕</button>
        </div>

        <div className="project-info-content">
          {!projectExists && (
            <div className="project-info-warning">
              <span className="warning-icon">⚠</span>
              <span>Projekt nicht gefunden! Der Pfad existiert nicht mehr.</span>
            </div>
          )}

          <div className="project-info-section">
            <h3>Pfad</h3>
            <code className={`project-info-path ${!projectExists ? 'path-missing' : ''}`}>{project.path}</code>
            <button
              className="project-path-btn"
              onClick={handleUpdatePath}
              disabled={updatingPath}
            >
              {updatingPath ? '...' : 'Pfad ändern'}
            </button>
          </div>

          {project.gitBranch && (
            <div className="project-info-section">
              <h3>Git</h3>
              <div className="project-info-git">
                <span className="project-info-branch">{project.gitBranch}</span>
                {project.gitDirty && <span className="project-info-dirty">● uncommitted</span>}
              </div>
            </div>
          )}

          <div className="project-info-section">
            <h3>Dokumentation</h3>
            {loading ? (
              <div className="project-info-loading">Lade...</div>
            ) : files ? (
              <div className="project-info-files">
                <div className={`project-info-file ${files.claudeMd.exists ? 'exists' : 'missing'}`}>
                  <span className="file-icon">{files.claudeMd.exists ? '✓' : '○'}</span>
                  <span className="file-name">CLAUDE.md</span>
                  <span className="file-size">{formatSize(files.claudeMd.size)}</span>
                </div>
                <div className={`project-info-file ${files.contextMd.exists ? 'exists' : 'missing'}`}>
                  <span className="file-icon">{files.contextMd.exists ? '✓' : '○'}</span>
                  <span className="file-name">CONTEXT.md</span>
                  <span className="file-size">{formatSize(files.contextMd.size)}</span>
                </div>
                <div className={`project-info-file ${files.decisionsMd.exists ? 'exists' : 'missing'}`}>
                  <span className="file-icon">{files.decisionsMd.exists ? '✓' : '○'}</span>
                  <span className="file-name">DECISIONS.md</span>
                  <span className="file-size">{formatSize(files.decisionsMd.size)}</span>
                </div>
                <div className={`project-info-file ${files.statusMd.exists ? 'exists' : 'missing'}`}>
                  <span className="file-icon">{files.statusMd.exists ? '✓' : '○'}</span>
                  <span className="file-name">STATUS.md</span>
                  <span className="file-size">{formatSize(files.statusMd.size)}</span>
                </div>
                <div className={`project-info-file ${files.tasksDir.exists ? 'exists' : 'missing'}`}>
                  <span className="file-icon">{files.tasksDir.exists ? '✓' : '○'}</span>
                  <span className="file-name">TASKS/</span>
                  <span className="file-size">{files.tasksDir.exists ? `${files.tasksDir.count} Dateien` : '—'}</span>
                </div>
              </div>
            ) : (
              <div className="project-info-error">Fehler beim Laden</div>
            )}
          </div>

          <div className="project-info-section">
            <h3>Typ</h3>
            <div className="project-info-type-desc">
              {project.type === 'tools' ? (
                <p>Engineering Toolbox — Deterministischer Modus für Wartung, Debugging und präzise Ausführung.</p>
              ) : (
                <p>Staff Engineering — Planungs- und Genehmigungsworkflow für grössere Features.</p>
              )}
            </div>
          </div>

          <div className="project-info-section">
            <h3>Einstellungen</h3>
            <label className="project-info-checkbox">
              <input
                type="checkbox"
                checked={unleashed}
                onChange={(e) => handleUnleashedChange(e.target.checked)}
                disabled={savingSettings}
              />
              <span className="checkbox-label">
                <span className="checkbox-title">Unleashed Mode</span>
                <span className="checkbox-desc">
                  Startet Claude mit --dangerously-skip-permissions (überspringt Bestätigungen)
                </span>
              </span>
              {savingSettings && <span className="checkbox-saving">...</span>}
            </label>
          </div>

          {vaultPath && (
            <div className="project-info-section wiki-section">
              <h3>🔮 Obsidian Wiki</h3>
              <div className="wiki-vault-info">
                <code className="wiki-vault-path">{vaultPath}</code>
              </div>

              <div className="wiki-options-group">
                <label className="project-info-checkbox">
                  <input
                    type="checkbox"
                    checked={wikiProjectEnabled}
                    onChange={(e) => handleWikiProjectToggle(e.target.checked)}
                    disabled={savingWiki}
                  />
                  <span className="checkbox-label">
                    <span className="checkbox-title">📄 Projekt-Wiki</span>
                    <span className="checkbox-desc">
                      Eigene Wiki-Seite für dieses Projekt
                      <br />
                      <code>{vaultPath}/Wiki/Projekte/{project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.md</code>
                    </span>
                  </span>
                  {savingWiki && <span className="checkbox-saving">...</span>}
                </label>

                <label className="project-info-checkbox">
                  <input
                    type="checkbox"
                    checked={wikiVaultIndexEnabled}
                    onChange={(e) => handleWikiVaultIndexToggle(e.target.checked)}
                    disabled={savingWiki}
                  />
                  <span className="checkbox-label">
                    <span className="checkbox-title">📑 Vault-Index Eintrag</span>
                    <span className="checkbox-desc">
                      Eintrag im Vault-Index (nur dieser Eintrag wird aktualisiert)
                      <br />
                      <code>{vaultPath}/Wiki/Projekte/_index.md</code>
                    </span>
                  </span>
                  {savingWiki && <span className="checkbox-saving">...</span>}
                </label>
              </div>

              {(wikiProjectEnabled || wikiVaultIndexEnabled) && (
                <div className="wiki-update-section">
                  <button
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
            </div>
          )}
        </div>

        <div className="project-info-footer">
          <button
            className="project-info-btn"
            onClick={() => window.electronAPI?.openInFinder(project.path)}
          >
            Im Finder öffnen
          </button>
          <button className="project-info-btn primary" onClick={onClose}>
            Schliessen
          </button>
        </div>
      </div>
    </div>
  );
}
