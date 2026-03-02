import { useState } from 'react';
import type { Project } from './App';

interface SidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onAction: (action: 'claude' | 'terminal' | 'finder' | 'screenshot' | 'editor', project: Project) => void;
  onAddProject: () => void;
  onAddProjectByPath: (path: string) => void;
  onRemoveProject: (project: Project) => void;
  onSetProjectType: (project: Project, type: 'tools' | 'projekt') => void;
  onShowLog: () => void;
  onShowInfo: () => void;
  loading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export default function Sidebar({
  projects,
  selectedProject,
  onSelectProject,
  onAction,
  onAddProject,
  onAddProjectByPath,
  onRemoveProject,
  onSetProjectType,
  onShowLog,
  onShowInfo,
  loading,
  searchQuery,
  onSearchChange,
}: SidebarProps) {
  const [isDragging, setIsDragging] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Check if it's a directory by looking at the path
      if (file.path) {
        onAddProjectByPath(file.path);
      }
    }
  }

  if (loading) {
    return (
      <aside className="sidebar">
        <div className="sidebar-header">Projekte</div>
        <div className="sidebar-loading">Lade...</div>
      </aside>
    );
  }

  return (
    <aside
      className={`sidebar ${isDragging ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="sidebar-header">
        <span>Projekte</span>
        <div className="sidebar-header-actions">
          <button className="header-btn" onClick={onShowLog} title="Activity Log (⌘L)">
            📋
          </button>
          <button className="header-btn" onClick={onShowInfo} title="Info">
            ℹ️
          </button>
          <button className="add-btn" onClick={onAddProject} title="Projekt hinzufügen">
            +
          </button>
        </div>
      </div>
      <div className="search-container">
        <input
          id="project-search"
          type="text"
          className="search-input"
          placeholder="Suchen... (⌘K)"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchQuery && (
          <button className="search-clear" onClick={() => onSearchChange('')}>✕</button>
        )}
      </div>
      <nav className="project-list">
        {projects.length === 0 ? (
          <div className="empty-projects">
            <p>Keine Projekte</p>
            <button className="add-first-btn" onClick={onAddProject}>
              + Projekt hinzufügen
            </button>
          </div>
        ) : (
          projects.map((project) => (
            <div
              key={project.id}
              className={`project-item ${selectedProject?.id === project.id ? 'active' : ''}`}
              onClick={() => onSelectProject(project)}
            >
              <button
                className="remove-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`"${project.name}" aus der Liste entfernen?`)) {
                    onRemoveProject(project);
                  }
                }}
                title="Projekt entfernen"
              >
                ✕
              </button>
              <div className="project-name-row">
                <span className="project-name">{project.name}</span>
                <button
                  className={`type-badge ${project.type}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const newType = project.type === 'tools' ? 'projekt' : 'tools';
                    const newTypeName = newType === 'tools' ? 'Tools' : 'Projekt';
                    if (confirm(`Typ zu "${newTypeName}" wechseln?`)) {
                      onSetProjectType(project, newType);
                    }
                  }}
                  title={`${project.type === 'tools' ? 'Tools' : 'Projekt'} (klicken zum wechseln)`}
                >
                  {project.type === 'tools' ? 'T' : 'P'}
                </button>
                {project.hasClaudeMd && <span className="claude-badge" title="Hat CLAUDE.md">MD</span>}
                {project.gitBranch && (
                  <span className={`git-badge ${project.gitDirty ? 'dirty' : ''}`} title={project.gitDirty ? 'Uncommitted changes' : 'Clean'}>
                    {project.gitBranch}
                  </span>
                )}
              </div>
              <span className="project-path-subtitle">{project.parentPath}</span>
              <div className="project-actions">
                <button
                  className="icon-btn primary"
                  onClick={(e) => { e.stopPropagation(); onAction('claude', project); }}
                  title="Claude starten"
                >
                  ▶
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => { e.stopPropagation(); onAction('terminal', project); }}
                  title="Terminal öffnen"
                >
                  ⌘
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => { e.stopPropagation(); onAction('finder', project); }}
                  title="Im Finder zeigen"
                >
                  📁
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => { e.stopPropagation(); onAction('screenshot', project); }}
                  title="Screenshot aus Zwischenablage"
                >
                  📷
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => { e.stopPropagation(); onAction('editor', project); }}
                  title="CLAUDE.md bearbeiten"
                >
                  📝
                </button>
              </div>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
