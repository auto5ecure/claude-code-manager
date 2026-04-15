import { useState } from 'react';
import type { CoworkRepository, SyncStatus, DeploymentConfig, DeploymentStatus } from '../../shared/types';
import CoworkSettingsModal from './CoworkSettingsModal';

interface CoworkPanelProps {
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
  onOpenRepoSettings: (repo: CoworkRepository) => void;
  onUpdateCoworkPath: (repo: CoworkRepository) => void;
  deploymentConfigs: DeploymentConfig[];
  deploymentStatus: Record<string, DeploymentStatus>;
  onDeploy: (config: DeploymentConfig) => void;
  onShowDeploymentLogs: (config: DeploymentConfig) => void;
  onRefreshDeploymentStatus: (config: DeploymentConfig) => void;
  onDeploymentConfigsChanged: () => void;
  onOpenDeploymentSettings: (config: DeploymentConfig) => void;
  onSetupDeployment: (repoPath: string) => void;
}

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
    case 'conflict': {
      const conflictCount = status.conflictFiles?.length || 0;
      return {
        icon: '!',
        text: conflictCount > 0 ? `${conflictCount} Konflikt${conflictCount !== 1 ? 'e' : ''}` : 'Conflict',
        className: 'conflict',
      };
    }
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
  const mainContainer = status.containers.find((c) => c.name.includes('web'));
  if (mainContainer?.status.includes('Up')) {
    return { icon: '✓', text: 'Online', className: 'online' };
  }
  return { icon: '?', text: 'Unbekannt', className: 'unknown' };
}

export default function CoworkPanel({
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
  onOpenRepoSettings,
  onUpdateCoworkPath,
  deploymentConfigs,
  deploymentStatus,
  onDeploy,
  onShowDeploymentLogs,
  onRefreshDeploymentStatus,
  onDeploymentConfigsChanged,
  onOpenDeploymentSettings,
  onSetupDeployment,
}: CoworkPanelProps) {
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
    setExpandedRepos((prev) => {
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
    return deploymentConfigs.find((c) => c.projectPath === repo.localPath);
  };

  return (
    <div className="panel-view cowork-panel">
      <div className="panel-header">
        <h2 className="panel-title">Coworking</h2>
        <div className="panel-header-actions">
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
            const repoExists = (repo as CoworkRepository & { exists?: boolean }).exists !== false;

            return (
              <div key={repo.id} className={`cowork-item-full ${isExpanded ? 'expanded' : ''} ${!repoExists ? 'missing' : ''}`}>
                {/* Collapsed Header */}
                <div className="cowork-item-header" onClick={() => toggleRepoExpanded(repo.id)}>
                  <span className={`expand-arrow ${isExpanded ? 'expanded' : ''}`}>▶</span>
                  <span className="cowork-icon">{repoExists ? '📁' : '⚠'}</span>
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
                  {repo.wikiEnabled && (
                    <span className="wiki-badge-mini" title="Obsidian Wiki aktiv">🔮</span>
                  )}
                  {!repoExists ? (
                    <button
                      className="cowork-path-btn-mini"
                      onClick={(e) => { e.stopPropagation(); onUpdateCoworkPath(repo); }}
                      title="Pfad ändern"
                    >
                      📂
                    </button>
                  ) : (
                    <button
                      className="cowork-claude-btn"
                      onClick={(e) => { e.stopPropagation(); onStartCoworkClaude(repo); }}
                      title="Claude starten"
                      disabled={lock?.locked && !lock.isOwnLock}
                    >
                      ▶
                    </button>
                  )}
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
                    {!repoExists && (
                      <div className="cowork-missing-warning">
                        <span>⚠ Pfad existiert nicht!</span>
                        <button
                          className="cowork-path-btn"
                          onClick={(e) => { e.stopPropagation(); onUpdateCoworkPath(repo); }}
                        >
                          Pfad ändern
                        </button>
                      </div>
                    )}
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
                        <span>{lock.isOwnLock ? 'Du arbeitest hier' : `${lock.lock?.user} arbeitet`}</span>
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
                      <button className="cowork-btn settings" onClick={() => onOpenRepoSettings(repo)} title="Einstellungen">⚙</button>
                      <button className="cowork-btn refresh" onClick={() => onRefreshCoworkStatus(repo)} title="Status aktualisieren">↻</button>
                      {repo.wikiEnabled && (
                        <button
                          className="cowork-btn wiki"
                          onClick={async () => {
                            const result = await (window as any).electronAPI?.updateCoworkWiki(repo.id);
                            if (result?.error) alert(result.error);
                            else alert('Wiki aktualisiert!');
                          }}
                          title="Wiki aktualisieren"
                        >
                          🔮
                        </button>
                      )}
                      <button className="cowork-btn sync" onClick={() => onCoworkSync(repo)} title="Sync">Sync</button>
                      {lock?.locked ? (
                        <button
                          className="unlock-btn force"
                          onClick={() => onCoworkUnlock(repo)}
                          title="Force Unlock"
                        >
                          🔓 Force Unlock
                        </button>
                      ) : (
                        <button
                          className="cowork-btn primary"
                          onClick={() => onStartCoworkClaude(repo)}
                          title="Claude starten"
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
                          <button className="cowork-btn" onClick={() => onRefreshDeploymentStatus(deployConfig)} title="Status aktualisieren">↻</button>
                          <button className="cowork-btn" onClick={() => onShowDeploymentLogs(deployConfig)} title="Logs anzeigen">📋</button>
                          <button className="cowork-btn" onClick={() => onOpenDeploymentSettings(deployConfig)} title="Einstellungen">⚙</button>
                          <button className="cowork-btn primary" onClick={() => onDeploy(deployConfig)} title="Deploy">Deploy ▶</button>
                        </div>
                      </div>
                    ) : (
                      <div className="cowork-deployment-setup">
                        <button
                          className="cowork-btn setup-deployment"
                          onClick={() => onSetupDeployment(repo.localPath)}
                          title="Deployment einrichten"
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

      {showSettingsModal && (
        <CoworkSettingsModal
          onClose={() => setShowSettingsModal(false)}
          onImportCowork={handleImportCowork}
          onExportCowork={handleExportCowork}
          onImportDeployment={handleImportDeployment}
          onExportDeployment={handleExportDeployment}
        />
      )}
    </div>
  );
}
