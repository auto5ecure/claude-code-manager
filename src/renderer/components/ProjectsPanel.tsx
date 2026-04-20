import { useState } from 'react';
import type { Project } from './App';

interface ProjectsPanelProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onAction: (action: 'claude' | 'terminal' | 'finder' | 'screenshot' | 'editor' | 'info' | 'wiki', project: Project) => void;
  onAddProject: () => void;
  onAddProjectByPath: (path: string) => void;
  onRemoveProject: (project: Project) => void;
  onSetProjectType: (project: Project, type: 'tools' | 'projekt') => void;
  onShowLog: () => void;
  loading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  unleashedSettings: Record<string, boolean>;
  onToggleUnleashed: (projectId: string, value: boolean) => void;
  openProjectPaths?: Set<string>;
}

export default function ProjectsPanel({
  projects,
  selectedProject,
  onSelectProject,
  onAction,
  onAddProject,
  onAddProjectByPath,
  onRemoveProject,
  onSetProjectType,
  onShowLog,
  loading,
  searchQuery,
  onSearchChange,
  unleashedSettings,
  onToggleUnleashed,
  openProjectPaths,
}: ProjectsPanelProps) {
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
      if (file.path) {
        onAddProjectByPath(file.path);
      }
    }
  }

  if (loading) {
    return (
      <div className="panel-view">
        <div className="sidebar-loading">Lade...</div>
      </div>
    );
  }

  return (
    <div
      className={`panel-view projects-panel ${isDragging ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="panel-header">
        <h2 className="panel-title">Projekte</h2>
        <div className="panel-header-actions">
          <button className="header-btn" onClick={onShowLog} title="Activity Log (⌘L)">
            📋
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
          projects.map((project) => {
            const isActive = selectedProject?.id === project.id;
            return (
              <div
                key={project.id}
                className={`project-item ${isActive ? 'active' : 'collapsed'} ${project.exists === false ? 'missing' : ''}`}
                onClick={() => onSelectProject(project)}
              >
                {isActive && (
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
                )}
                <div className="project-name-row">
                  <span className="project-name">{project.name}</span>
                  {openProjectPaths?.has(project.path) && <span className="tab-open-dot" title="Terminal offen" />}
                  <div className="project-badges">
                    <button
                      className={`type-badge ${project.type}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isActive) return;
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
                </div>
                {isActive && (
                  <>
                    <span className="project-path-subtitle">{project.parentPath}</span>
                    <div className="project-actions">
                      <label
                        className="unleashed-toggle"
                        title="Unleashed (überspringt Bestätigungen)"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={unleashedSettings[project.id] || false}
                          onChange={(e) => onToggleUnleashed(project.id, e.target.checked)}
                        />
                        <span className="toggle-label">Unleashed</span>
                      </label>
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
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); onAction('wiki', project); }}
                        title="Obsidian Wiki aktualisieren"
                      >
                        🔮
                      </button>
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); onAction('info', project); }}
                        title="Projekt-Info"
                      >
                        ℹ️
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </nav>
    </div>
  );
}
