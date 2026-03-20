import { useState, useEffect } from 'react';
import type { Project } from './App';

interface ProjectInfoModalProps {
  project: Project;
  onClose: () => void;
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

export default function ProjectInfoModal({ project, onClose }: ProjectInfoModalProps) {
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [unleashed, setUnleashed] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    loadProjectFiles();
    loadProjectSettings();
  }, [project]);

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
          <div className="project-info-section">
            <h3>Pfad</h3>
            <code className="project-info-path">{project.path}</code>
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
