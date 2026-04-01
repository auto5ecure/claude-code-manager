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

interface WikiSettings {
  enabled: boolean;
  vaultPath?: string;
  projectWikiFormat: 'folder' | 'file';
  changelogEnabled: boolean;
  fileTrackingEnabled: boolean;
  lastUpdated?: string;
}

export default function ProjectInfoModal({ project, onClose, onProjectUpdated }: ProjectInfoModalProps) {
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [unleashed, setUnleashed] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [updatingPath, setUpdatingPath] = useState(false);

  // Wiki integration state
  const [wikiEnabled, setWikiEnabled] = useState(false);
  const [wikiSettings, setWikiSettings] = useState<WikiSettings>({
    enabled: false,
    projectWikiFormat: 'file',
    changelogEnabled: true,
    fileTrackingEnabled: true,
  });
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [savingWiki, setSavingWiki] = useState(false);

  const projectExists = project.exists !== false;

  useEffect(() => {
    loadProjectFiles();
    loadProjectSettings();
    loadWikiSettings();
    detectVault();
  }, [project]);

  async function loadWikiSettings() {
    try {
      const settings = await window.electronAPI?.getWikiSettings(project.id);
      if (settings) {
        setWikiSettings(settings);
        setWikiEnabled(settings.enabled);
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

  async function handleWikiToggle(checked: boolean) {
    setWikiEnabled(checked);
    setSavingWiki(true);
    try {
      const newSettings: WikiSettings = {
        ...wikiSettings,
        enabled: checked,
        vaultPath: vaultPath || undefined,
      };
      await window.electronAPI?.saveWikiSettings(project.id, newSettings);
      setWikiSettings(newSettings);

      // Trigger initial wiki generation if enabled
      if (checked) {
        await window.electronAPI?.updateProjectWiki(project.path, project.id);
      }
    } catch (err) {
      console.error('Failed to save wiki settings:', err);
    }
    setSavingWiki(false);
  }

  async function handleWikiFormatChange(format: 'folder' | 'file') {
    setSavingWiki(true);
    try {
      const newSettings: WikiSettings = {
        ...wikiSettings,
        projectWikiFormat: format,
      };
      await window.electronAPI?.saveWikiSettings(project.id, newSettings);
      setWikiSettings(newSettings);
    } catch (err) {
      console.error('Failed to save wiki format:', err);
    }
    setSavingWiki(false);
  }

  async function handleChangelogToggle(checked: boolean) {
    setSavingWiki(true);
    try {
      const newSettings: WikiSettings = {
        ...wikiSettings,
        changelogEnabled: checked,
      };
      await window.electronAPI?.saveWikiSettings(project.id, newSettings);
      setWikiSettings(newSettings);
    } catch (err) {
      console.error('Failed to save changelog setting:', err);
    }
    setSavingWiki(false);
  }

  async function handleManualWikiUpdate() {
    setSavingWiki(true);
    try {
      const result = await window.electronAPI?.updateProjectWiki(project.path, project.id);
      if (result?.success) {
        loadWikiSettings(); // Reload to get updated timestamp
      }
    } catch (err) {
      console.error('Manual wiki update failed:', err);
    }
    setSavingWiki(false);
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

          <div className="project-info-section wiki-section">
            <h3>Wiki Integration</h3>
            {vaultPath ? (
              <div className="wiki-vault-info">
                <span className="wiki-vault-detected">Obsidian Vault erkannt</span>
                <code className="wiki-vault-path">{vaultPath}</code>
              </div>
            ) : (
              <div className="wiki-vault-info wiki-no-vault">
                <span>Kein Obsidian Vault im Pfad gefunden</span>
              </div>
            )}

            <label className="project-info-checkbox">
              <input
                type="checkbox"
                checked={wikiEnabled}
                onChange={(e) => handleWikiToggle(e.target.checked)}
                disabled={savingWiki}
              />
              <span className="checkbox-label">
                <span className="checkbox-title">Wiki aktivieren</span>
                <span className="checkbox-desc">
                  Generiert automatisch Wiki-Dokumentation bei Session-Ende
                </span>
              </span>
              {savingWiki && <span className="checkbox-saving">...</span>}
            </label>

            {wikiEnabled && (
              <div className="wiki-options">
                <div className="wiki-format-selector">
                  <span className="wiki-option-label">Format:</span>
                  <button
                    className={`wiki-format-btn ${wikiSettings.projectWikiFormat === 'file' ? 'active' : ''}`}
                    onClick={() => handleWikiFormatChange('file')}
                    disabled={savingWiki}
                  >
                    WIKI.md
                  </button>
                  <button
                    className={`wiki-format-btn ${wikiSettings.projectWikiFormat === 'folder' ? 'active' : ''}`}
                    onClick={() => handleWikiFormatChange('folder')}
                    disabled={savingWiki}
                  >
                    Wiki/README.md
                  </button>
                </div>

                <label className="project-info-checkbox wiki-sub-option">
                  <input
                    type="checkbox"
                    checked={wikiSettings.changelogEnabled}
                    onChange={(e) => handleChangelogToggle(e.target.checked)}
                    disabled={savingWiki}
                  />
                  <span className="checkbox-label">
                    <span className="checkbox-title">Changelog</span>
                    <span className="checkbox-desc">Session-Änderungen protokollieren</span>
                  </span>
                </label>

                {wikiSettings.lastUpdated && (
                  <div className="wiki-last-update">
                    Letzte Aktualisierung: {new Date(wikiSettings.lastUpdated).toLocaleString('de-DE')}
                  </div>
                )}

                <button
                  className="wiki-update-btn"
                  onClick={handleManualWikiUpdate}
                  disabled={savingWiki}
                >
                  {savingWiki ? 'Aktualisiere...' : 'Wiki jetzt aktualisieren'}
                </button>
              </div>
            )}
          </div>
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
