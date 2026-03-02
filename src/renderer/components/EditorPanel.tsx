import { useState, useEffect } from 'react';
import type { Project } from './App';

interface EditorPanelProps {
  project: Project;
  onClose: () => void;
}

export default function EditorPanel({ project, onClose }: EditorPanelProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadContent();
  }, [project.path]);

  async function loadContent() {
    setLoading(true);
    console.log('Loading CLAUDE.md for:', project.path, 'type:', project.type);
    const md = await window.electronAPI?.getProjectClaudeMd(project.path);
    console.log('Got content:', md ? `${md.length} chars` : 'null (loading template)');

    let text = md;
    if (!md) {
      // Load template based on project type
      const template = await window.electronAPI?.getTemplate(project.type || 'projekt');
      text = template || '# CLAUDE.md\n\nProjekt-Anweisungen hier...\n';
    }

    setContent(text);
    setOriginalContent(md || '');
    setHasChanges(md === null || md === undefined);
    setLoading(false);
  }

  function handleChange(value: string) {
    setContent(value);
    setHasChanges(value !== originalContent);
  }

  async function handleSave() {
    setSaving(true);
    await window.electronAPI?.saveProjectClaudeMd(project.path, content);
    setOriginalContent(content);
    setHasChanges(false);
    setSaving(false);
  }

  function handleClose() {
    if (hasChanges) {
      if (confirm('Ungespeicherte Änderungen verwerfen?')) {
        onClose();
      }
    } else {
      onClose();
    }
  }

  return (
    <div className="editor-panel">
      <div className="editor-header">
        <div className="editor-title">
          <span className="editor-icon">📝</span>
          <span>CLAUDE.md - {project.name}</span>
          <span className={`editor-type-badge ${project.type}`}>
            {project.type === 'tools' ? 'Tools' : 'Projekt'}
          </span>
          {hasChanges && <span className="unsaved-dot" title="Ungespeicherte Änderungen" />}
        </div>
        <div className="editor-actions">
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Speichern...' : 'Speichern'}
          </button>
          <button className="btn-close" onClick={handleClose}>✕</button>
        </div>
      </div>
      <div className="editor-content">
        {loading ? (
          <div className="editor-loading">Lade...</div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="CLAUDE.md Inhalt..."
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
