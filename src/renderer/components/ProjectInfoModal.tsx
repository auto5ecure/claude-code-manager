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

interface GastownRigStatus {
  isRig: boolean;
  rigName?: string;
  prefix?: string;
  beadsCount?: number;
}

interface ProjectTags {
  context?: string;
  template?: string;
  tags?: string[];
  secrets?: string[];
}

export default function ProjectInfoModal({ project, onClose, onProjectUpdated }: ProjectInfoModalProps) {
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [unleashed, setUnleashed] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [updatingPath, setUpdatingPath] = useState(false);

  // Gastown integration state
  const [rigStatus, setRigStatus] = useState<GastownRigStatus | null>(null);
  const [gastownInstalled, setGastownInstalled] = useState(false);
  const [addingRig, setAddingRig] = useState(false);
  const [rigPrefix, setRigPrefix] = useState('');
  const [rigError, setRigError] = useState<string | null>(null);

  // Tags state
  const [projectTags, setProjectTags] = useState<ProjectTags>({});
  const [savingTags, setSavingTags] = useState(false);
  const [newTag, setNewTag] = useState('');

  const projectExists = project.exists !== false;

  useEffect(() => {
    loadProjectFiles();
    loadProjectSettings();
    loadGastownStatus();
    loadProjectTags();
  }, [project]);

  async function loadGastownStatus() {
    try {
      const gastownStatus = await window.electronAPI?.getGastownStatus?.();
      setGastownInstalled(gastownStatus?.installed ?? false);

      if (gastownStatus?.installed) {
        const status = await window.electronAPI?.getRigStatus?.(project.path);
        setRigStatus(status || { isRig: false });
        // Default prefix from project name (first 2 chars)
        if (!status?.isRig) {
          setRigPrefix(project.name.substring(0, 2).toLowerCase());
        }
      }
    } catch (err) {
      console.error('Failed to load Gastown status:', err);
    }
  }

  async function loadProjectTags() {
    try {
      const tags = await window.electronAPI?.getProjectTags?.(project.path);
      setProjectTags(tags || {});
    } catch (err) {
      console.error('Failed to load project tags:', err);
    }
  }

  async function handleAddRig() {
    if (!rigPrefix) {
      setRigError('Prefix erforderlich');
      return;
    }

    setAddingRig(true);
    setRigError(null);
    try {
      const rigName = project.name.replace(/-/g, '_');
      const result = await window.electronAPI?.addRig?.(project.path, rigName, rigPrefix);
      if (result?.success) {
        await loadGastownStatus();
      } else {
        setRigError(result?.error || 'Fehler beim Hinzufügen');
      }
    } catch (err) {
      setRigError((err as Error).message);
    }
    setAddingRig(false);
  }

  async function handleContextChange(context: string) {
    const newTags = { ...projectTags, context };
    setProjectTags(newTags);
    await saveProjectTags(newTags);
  }

  async function handleTemplateChange(template: string) {
    const newTags = { ...projectTags, template };
    setProjectTags(newTags);
    await saveProjectTags(newTags);
  }

  async function handleAddTag() {
    if (!newTag.trim()) return;
    const tags = [...(projectTags.tags || []), newTag.trim()];
    const newProjectTags = { ...projectTags, tags };
    setProjectTags(newProjectTags);
    setNewTag('');
    await saveProjectTags(newProjectTags);
  }

  async function handleRemoveTag(tag: string) {
    const tags = (projectTags.tags || []).filter(t => t !== tag);
    const newProjectTags = { ...projectTags, tags };
    setProjectTags(newProjectTags);
    await saveProjectTags(newProjectTags);
  }

  async function saveProjectTags(tags: ProjectTags) {
    setSavingTags(true);
    try {
      await window.electronAPI?.saveProjectTags?.(project.path, tags);
    } catch (err) {
      console.error('Failed to save tags:', err);
    }
    setSavingTags(false);
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

          {/* Gastown Integration */}
          {gastownInstalled && (
            <div className="project-info-section gastown-section">
              <h3>Gastown</h3>
              {rigStatus?.isRig ? (
                <div className="gastown-rig-info">
                  <div className="rig-status active">
                    <span className="rig-indicator">●</span>
                    <span className="rig-name">{rigStatus.rigName}</span>
                    <span className="rig-prefix">[{rigStatus.prefix}]</span>
                  </div>
                  {rigStatus.beadsCount !== undefined && rigStatus.beadsCount > 0 && (
                    <div className="rig-beads">
                      <span className="beads-count">{rigStatus.beadsCount} Beads</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="gastown-add-rig">
                  <div className="rig-status inactive">
                    <span className="rig-indicator">○</span>
                    <span>Nicht als Rig registriert</span>
                  </div>
                  <div className="add-rig-form">
                    <input
                      type="text"
                      placeholder="Prefix (2-3 Zeichen)"
                      value={rigPrefix}
                      onChange={(e) => setRigPrefix(e.target.value.toLowerCase().substring(0, 3))}
                      maxLength={3}
                      className="rig-prefix-input"
                    />
                    <button
                      className="btn-add-rig"
                      onClick={handleAddRig}
                      disabled={addingRig || !rigPrefix}
                    >
                      {addingRig ? '...' : 'Als Rig hinzufügen'}
                    </button>
                  </div>
                  {rigError && <div className="rig-error">{rigError}</div>}
                </div>
              )}
            </div>
          )}

          {/* Context & Tags */}
          <div className="project-info-section tags-section">
            <h3>Context & Tags</h3>
            <div className="tags-editor">
              <div className="tag-row">
                <label className="tag-label">Context:</label>
                <select
                  value={projectTags.context || ''}
                  onChange={(e) => handleContextChange(e.target.value)}
                  disabled={savingTags}
                  className="tag-select"
                >
                  <option value="">-- Auswählen --</option>
                  <option value="privat">privat</option>
                  <option value="autosecure">autosecure</option>
                  <option value="TimonEsserIT">TimonEsserIT</option>
                </select>
              </div>
              <div className="tag-row">
                <label className="tag-label">Template:</label>
                <select
                  value={projectTags.template || ''}
                  onChange={(e) => handleTemplateChange(e.target.value)}
                  disabled={savingTags}
                  className="tag-select"
                >
                  <option value="">-- Auswählen --</option>
                  <option value="tools">tools</option>
                  <option value="projekt">projekt</option>
                </select>
              </div>
              <div className="tag-row">
                <label className="tag-label">Tags:</label>
                <div className="tags-list">
                  {(projectTags.tags || []).map((tag) => (
                    <span key={tag} className="tag-chip">
                      {tag}
                      <button
                        className="tag-remove"
                        onClick={() => handleRemoveTag(tag)}
                        disabled={savingTags}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <div className="tag-add">
                    <input
                      type="text"
                      placeholder="Neuer Tag..."
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                      className="tag-input"
                    />
                    <button
                      className="btn-add-tag"
                      onClick={handleAddTag}
                      disabled={savingTags || !newTag.trim()}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
              {savingTags && <span className="tags-saving">Speichern...</span>}
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
