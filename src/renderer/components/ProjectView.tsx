import { useState, useEffect } from 'react';
import type { Project } from './App';

interface ProjectViewProps {
  project: Project | null;
}

export default function ProjectView({ project }: ProjectViewProps) {
  const [claudeMd, setClaudeMd] = useState<string | null>(null);
  const [editingMd, setEditingMd] = useState(false);
  const [mdContent, setMdContent] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) {
      loadProjectData();
    }
  }, [project]);

  async function loadProjectData() {
    if (!project) return;

    const md = await window.electronAPI?.getProjectClaudeMd(project.path);
    setClaudeMd(md);
    setMdContent(md || '');
    setEditingMd(false);

    const s = await window.electronAPI?.getProjectSettings(project.id);
    setSettings(s);
  }

  async function handleSaveClaudeMd() {
    if (!project) return;
    setSaving(true);
    await window.electronAPI?.saveProjectClaudeMd(project.path, mdContent);
    setClaudeMd(mdContent);
    setEditingMd(false);
    setSaving(false);
  }

  function handleOpenFinder() {
    if (project) window.electronAPI?.openInFinder(project.path);
  }

  function handleOpenTerminal() {
    if (project) window.electronAPI?.openInTerminal(project.path);
  }

  function handleStartClaude() {
    if (project) window.electronAPI?.startClaude(project.path);
  }

  if (!project) {
    return (
      <main className="project-view">
        <div className="empty-state">
          <h2>Kein Projekt ausgewählt</h2>
          <p>Wähle ein Projekt aus der Seitenleiste</p>
        </div>
      </main>
    );
  }

  return (
    <main className="project-view">
      <header className="project-header">
        <h2>{project.name}</h2>
        <p className="project-path">{project.path}</p>
      </header>

      <section className="actions-section">
        <h3>Aktionen</h3>
        <div className="action-buttons">
          <button className="action-btn primary" onClick={handleStartClaude}>
            <span className="icon">▶</span>
            Claude starten
          </button>
          <button className="action-btn" onClick={handleOpenTerminal}>
            <span className="icon">⌘</span>
            Terminal öffnen
          </button>
          <button className="action-btn" onClick={handleOpenFinder}>
            <span className="icon">📁</span>
            Im Finder zeigen
          </button>
        </div>
      </section>

      <section className="claude-md-section">
        <div className="section-header">
          <h3>CLAUDE.md</h3>
          {!editingMd && (
            <button className="edit-btn" onClick={() => setEditingMd(true)}>
              {claudeMd === null ? 'Erstellen' : 'Bearbeiten'}
            </button>
          )}
        </div>

        {editingMd ? (
          <div className="editor-container">
            <textarea
              className="md-editor"
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              placeholder="# Projekt-Instruktionen für Claude&#10;&#10;Hier kannst du projektspezifische Anweisungen schreiben..."
            />
            <div className="editor-actions">
              <button className="save-btn" onClick={handleSaveClaudeMd} disabled={saving}>
                {saving ? 'Speichern...' : 'Speichern'}
              </button>
              <button className="cancel-btn" onClick={() => { setEditingMd(false); setMdContent(claudeMd || ''); }}>
                Abbrechen
              </button>
            </div>
          </div>
        ) : claudeMd ? (
          <pre className="md-preview">{claudeMd}</pre>
        ) : (
          <p className="no-content">Keine CLAUDE.md vorhanden</p>
        )}
      </section>

      {settings && (
        <section className="settings-section">
          <h3>Projekt-Einstellungen</h3>
          <pre className="settings-preview">{JSON.stringify(settings, null, 2)}</pre>
        </section>
      )}
    </main>
  );
}
