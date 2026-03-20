import { useState } from 'react';
import type { Project } from './App';
import type { CoworkRepository, SyncStatus, DeploymentConfig, DeploymentStatus } from '../../shared/types';
import CoworkSettingsModal from './CoworkSettingsModal';

interface SidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onAction: (action: 'claude' | 'terminal' | 'finder' | 'screenshot' | 'editor' | 'info', project: Project) => void;
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
  // Cowork props
  coworkRepos: CoworkRepository[];
  coworkSyncStatus: Record<string, SyncStatus>;
  coworkLockStatus: Record<string, {
    locked: boolean;
    lock?: { user: string; machine: string; timestamp: string };
    isStale?: boolean;
    isOwnLock?: boolean;
    age?: number;
  }>;
  onAddCoworkRepository: () => void;
  onRemoveCoworkRepository: (repo: CoworkRepository) => void;
  onCoworkSync: (repo: CoworkRepository) => void;
  onStartCoworkClaude: (repo: CoworkRepository) => void;
  onRefreshCoworkStatus: (repo: CoworkRepository) => void;
  onCoworkUnlock: (repo: CoworkRepository) => void;
  onCoworkReposChanged: () => void;
  onToggleCoworkUnleashed: (repoId: string, value: boolean) => void;
  // Deployment props
  deploymentConfigs: DeploymentConfig[];
  deploymentStatus: Record<string, DeploymentStatus>;
  onDeploy: (config: DeploymentConfig) => void;
  onShowDeploymentLogs: (config: DeploymentConfig) => void;
  onRefreshDeploymentStatus: (config: DeploymentConfig) => void;
  onDeploymentConfigsChanged: () => void;
  onOpenDeploymentSettings: (config: DeploymentConfig) => void;
  onSetupDeployment: (repoPath: string) => void;
}

type TabType = 'projects' | 'cowork';

function getSyncBadge(status: SyncStatus | undefined): { icon: string; text: string; className: string } {
  if (!status) {
    return { icon: '...', text: 'Prüfe...', className: 'checking' };
  }
  switch (status.state) {
    case 'synced':
      return { icon: '✓', text: 'Synced', className: 'synced' };
    case 'behind':
      return { icon: '↓', text: `${status.behind} behind`, className: 'behind' };
    case 'ahead':
      return { icon: '↑', text: `${status.ahead} ahead`, className: 'ahead' };
    case 'diverged':
      return { icon: '⇅', text: `${status.ahead}↑ ${status.behind}↓`, className: 'diverged' };
    case 'conflict':
      const conflictCount = status.conflictFiles?.length || 0;
      return {
        icon: '!',
        text: conflictCount > 0 ? `${conflictCount} Konflikt${conflictCount !== 1 ? 'e' : ''}` : 'Conflict',
        className: 'conflict'
      };
    default:
      return { icon: '?', text: 'Unknown', className: 'unknown' };
  }
}

function getDeploymentBadge(status: DeploymentStatus | undefined): { icon: string; text: string; className: string } {
  if (!status) {
    return { icon: '...', text: 'Prüfe...', className: 'checking' };
  }
  if (status.error) {
    return { icon: '!', text: 'Fehler', className: 'error' };
  }
  if (!status.isOnline) {
    return { icon: '✗', text: 'Offline', className: 'offline' };
  }
  const mainContainer = status.containers.find(c => c.name.includes('web'));
  if (mainContainer?.status.includes('Up')) {
    return { icon: '✓', text: 'Online', className: 'online' };
  }
  return { icon: '?', text: 'Unbekannt', className: 'unknown' };
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
  loading,
  searchQuery,
  onSearchChange,
  unleashedSettings,
  onToggleUnleashed,
  coworkRepos,
  coworkSyncStatus,
  coworkLockStatus,
  onAddCoworkRepository,
  onRemoveCoworkRepository,
  onCoworkSync,
  onStartCoworkClaude,
  onRefreshCoworkStatus,
  onCoworkUnlock,
  onCoworkReposChanged,
  onToggleCoworkUnleashed,
  deploymentConfigs,
  deploymentStatus,
  onDeploy,
  onShowDeploymentLogs,
  onRefreshDeploymentStatus,
  onDeploymentConfigsChanged,
  onOpenDeploymentSettings,
  onSetupDeployment,
}: SidebarProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('projects');
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const handleImportDeployment = async () => {
    const result = await (window as any).electronAPI?.importDeploymentConfigs();
    if (result?.success && result.imported > 0) {
      onDeploymentConfigsChanged();
      alert(`${result.imported} Deployment-Config(s) importiert`);
    } else if (result?.error) {
      alert(`Import fehlgeschlagen: ${result.error}`);
    }
  };

  const handleExportDeployment = async () => {
    const result = await (window as any).electronAPI?.exportDeploymentConfigs();
    if (result?.success) {
      alert('Deployment-Konfigurationen exportiert');
    } else if (result?.error) {
      alert(`Export fehlgeschlagen: ${result.error}`);
    }
  };

  const handleExportCowork = async () => {
    const result = await (window as any).electronAPI?.exportCoworkRepositories();
    if (result?.success) {
      alert('Cowork-Repositories exportiert');
    } else if (result?.error) {
      alert(`Export fehlgeschlagen: ${result.error}`);
    }
  };

  const handleImportCowork = async () => {
    const result = await (window as any).electronAPI?.importCoworkRepositories();
    if (result?.success && result.imported > 0) {
      onCoworkReposChanged();
      alert(`${result.imported} Cowork-Repository(s) importiert`);
    } else if (result?.error) {
      alert(`Import fehlgeschlagen: ${result.error}`);
    }
  };

  const toggleRepoExpanded = (repoId: string) => {
    setExpandedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  };

  const getDeploymentForRepo = (repo: CoworkRepository): DeploymentConfig | undefined => {
    return deploymentConfigs.find(c => c.projectPath === repo.localPath);
  };

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
      <aside className="sidebar">
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
      {/* Tab Header */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${activeTab === 'projects' ? 'active' : ''}`}
          onClick={() => setActiveTab('projects')}
        >
          Projekte
        </button>
        <button
          className={`sidebar-tab ${activeTab === 'cowork' ? 'active' : ''}`}
          onClick={() => setActiveTab('cowork')}
        >
          Coworking
          {coworkRepos.length > 0 && <span className="tab-badge">{coworkRepos.length}</span>}
        </button>
      </div>

      {/* Projects Tab */}
      {activeTab === 'projects' && (
        <>
          <div className="sidebar-header">
            <div className="sidebar-header-actions">
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
                      onClick={(e) => { e.stopPropagation(); onAction('info', project); }}
                      title="Projekt-Info"
                    >
                      ℹ️
                    </button>
                  </div>
                </div>
              ))
            )}
          </nav>
        </>
      )}

      {/* Cowork Tab */}
      {activeTab === 'cowork' && (
        <>
          <div className="sidebar-header">
            <div className="sidebar-header-actions">
              <button className="header-btn settings" onClick={() => setShowSettingsModal(true)} title="Einstellungen">
                ⚙
              </button>
              <button className="add-btn" onClick={onAddCoworkRepository} title="Repository hinzufügen">
                +
              </button>
            </div>
          </div>
          <div className="cowork-list-full">
            {coworkRepos.length === 0 ? (
              <div className="empty-projects">
                <p>Keine Cowork-Repositories</p>
                <button className="add-first-btn" onClick={onAddCoworkRepository}>
                  + Repository hinzufügen
                </button>
              </div>
            ) : (
              coworkRepos.map((repo) => {
                const status = coworkSyncStatus[repo.id];
                const lock = coworkLockStatus[repo.id];
                const badge = getSyncBadge(status);
                const isExpanded = expandedRepos.has(repo.id);
                const deployConfig = getDeploymentForRepo(repo);
                const deployStatus = deployConfig ? deploymentStatus[deployConfig.id] : undefined;
                const deployBadge = deployConfig ? getDeploymentBadge(deployStatus) : undefined;

                return (
                  <div key={repo.id} className={`cowork-item-full ${isExpanded ? 'expanded' : ''}`}>
                    {/* Collapsed Header - always visible */}
                    <div
                      className="cowork-item-header"
                      onClick={() => toggleRepoExpanded(repo.id)}
                    >
                      <span className={`expand-arrow ${isExpanded ? 'expanded' : ''}`}>▶</span>
                      <span className="cowork-icon">📁</span>
                      <span className="cowork-name">{repo.name}</span>
                      <span className={`sync-badge-mini ${badge.className}`} title={badge.text}>
                        {badge.icon}
                      </span>
                      {lock?.locked && (
                        <span className="lock-badge-mini" title={lock.isOwnLock ? 'Du arbeitest hier' : `${lock.lock?.user} arbeitet`}>
                          {lock.isOwnLock ? '🔓' : '🔒'}
                        </span>
                      )}
                      {deployConfig && deployBadge && (
                        <span className={`deploy-badge-mini ${deployBadge.className}`} title={`Deployment: ${deployBadge.text}`}>
                          🚀
                        </span>
                      )}
                      <button
                        className="cowork-claude-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartCoworkClaude(repo);
                        }}
                        title="Claude starten"
                        disabled={lock?.locked && !lock.isOwnLock}
                      >
                        ▶
                      </button>
                      <button
                        className="cowork-remove-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`"${repo.name}" aus Coworking entfernen?`)) {
                            onRemoveCoworkRepository(repo);
                          }
                        }}
                        title="Repository entfernen"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="cowork-item-content">
                        <div className="cowork-meta">
                          <span className="cowork-url" title={repo.githubUrl}>
                            {repo.githubUrl.replace('https://github.com/', '')}
                          </span>
                          <span className="cowork-branch">{repo.branch}</span>
                        </div>

                        <div className="cowork-status-row">
                          <span className={`sync-badge ${badge.className}`}>
                            <span className="sync-badge-icon">{badge.icon}</span>
                            <span className="sync-badge-text">{badge.text}</span>
                          </span>
                        </div>

                        {status?.hasUncommittedChanges && (
                          <div className="cowork-changes">
                            {status.changedFiles.length} uncommitted change{status.changedFiles.length !== 1 ? 's' : ''}
                          </div>
                        )}

                        {lock?.locked && (
                          <div className={`cowork-lock-badge ${lock.isOwnLock ? 'own' : ''}`}>
                            <span className="lock-emoji">{lock.isOwnLock ? '🔓' : '🔒'}</span>
                            <span>
                              {lock.isOwnLock ? 'Du arbeitest hier' : `${lock.lock?.user} arbeitet`}
                            </span>
                          </div>
                        )}

                        <div className="cowork-actions">
                          <label
                            className="unleashed-toggle cowork-unleashed"
                            title="Unleashed (überspringt Bestätigungen)"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={repo.unleashed || false}
                              onChange={(e) => onToggleCoworkUnleashed(repo.id, e.target.checked)}
                            />
                            <span className="toggle-label">Unleashed</span>
                          </label>
                          <button
                            className="cowork-btn refresh"
                            onClick={() => onRefreshCoworkStatus(repo)}
                            title="Status aktualisieren"
                          >
                            ↻
                          </button>
                          <button
                            className="cowork-btn sync"
                            onClick={() => onCoworkSync(repo)}
                            title="Sync"
                          >
                            Sync
                          </button>
                          {lock?.isOwnLock ? (
                            <button
                              className="unlock-btn"
                              onClick={() => onCoworkUnlock(repo)}
                              title="Lock freigeben"
                            >
                              🔓 Unlock
                            </button>
                          ) : (
                            <button
                              className="cowork-btn primary"
                              onClick={() => onStartCoworkClaude(repo)}
                              title="Claude starten"
                              disabled={lock?.locked && !lock.isOwnLock}
                            >
                              Claude ▶
                            </button>
                          )}
                        </div>

                        {/* Deployment Section */}
                        {deployConfig ? (
                          <div className="cowork-deployment">
                            <div className="cowork-deployment-header">
                              <span className="deployment-icon">🚀</span>
                              <span className="deployment-label">Deployment</span>
                              {deployBadge && (
                                <span className={`deployment-badge ${deployBadge.className}`}>
                                  {deployBadge.icon} {deployBadge.text}
                                </span>
                              )}
                            </div>
                            <div className="cowork-deployment-actions">
                              <button
                                className="cowork-btn"
                                onClick={() => onRefreshDeploymentStatus(deployConfig)}
                                title="Status aktualisieren"
                              >
                                ↻
                              </button>
                              <button
                                className="cowork-btn"
                                onClick={() => onShowDeploymentLogs(deployConfig)}
                                title="Logs anzeigen"
                              >
                                📋
                              </button>
                              <button
                                className="cowork-btn"
                                onClick={() => onOpenDeploymentSettings(deployConfig)}
                                title="Einstellungen"
                              >
                                ⚙
                              </button>
                              <button
                                className="cowork-btn primary"
                                onClick={() => onDeploy(deployConfig)}
                                title="Deploy"
                              >
                                Deploy ▶
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="cowork-deployment-setup">
                            <button
                              className="cowork-btn setup-deployment"
                              onClick={() => onSetupDeployment(repo.localPath)}
                              title="Deployment für dieses Repo einrichten"
                            >
                              🚀 Deployment einrichten
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
      {showSettingsModal && (
        <CoworkSettingsModal
          onClose={() => setShowSettingsModal(false)}
          onImportCowork={handleImportCowork}
          onExportCowork={handleExportCowork}
          onImportDeployment={handleImportDeployment}
          onExportDeployment={handleExportDeployment}
        />
      )}
    </aside>
  );
}
