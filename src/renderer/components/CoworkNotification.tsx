import type { CoworkRepository, SyncStatus } from '../../shared/types';

interface CoworkNotificationProps {
  repositories: CoworkRepository[];
  syncStatus: Record<string, SyncStatus>;
  onPull: (repo: CoworkRepository) => void;
  onDismiss: (repoId: string) => void;
  dismissedRepos: Set<string>;
}

export default function CoworkNotification({
  repositories,
  syncStatus,
  onPull,
  onDismiss,
  dismissedRepos,
}: CoworkNotificationProps) {
  // Find repos that are behind and not dismissed
  const behindRepos = repositories.filter((repo) => {
    const status = syncStatus[repo.id];
    if (!status) return false;
    if (dismissedRepos.has(repo.id)) return false;
    return status.state === 'behind' || status.state === 'diverged';
  });

  if (behindRepos.length === 0) return null;

  return (
    <div className="cowork-notification-container">
      {behindRepos.map((repo) => {
        const status = syncStatus[repo.id];
        const isDiverged = status?.state === 'diverged';

        return (
          <div key={repo.id} className={`cowork-notification ${isDiverged ? 'diverged' : 'behind'}`}>
            <div className="cowork-notification-icon">
              {isDiverged ? '⚠️' : '↓'}
            </div>
            <div className="cowork-notification-content">
              <strong>{repo.name}</strong>
              <span>
                {isDiverged
                  ? `${status.behind} neue Commits & ${status.ahead} lokale Commits`
                  : `${status.behind} neue Commit${status.behind !== 1 ? 's' : ''} verfügbar`}
              </span>
            </div>
            <div className="cowork-notification-actions">
              <button
                className="notification-btn pull"
                onClick={() => onPull(repo)}
              >
                {isDiverged ? 'Trotzdem Pull' : 'Pull'}
              </button>
              <button
                className="notification-btn dismiss"
                onClick={() => onDismiss(repo.id)}
                title="Später"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
