import { useEffect } from 'react';
import type { CoworkRepository, SyncStatus } from '../../shared/types';

const AUTO_DISMISS_MS = 8000;

interface CoworkNotificationProps {
  repositories: CoworkRepository[];
  syncStatus: Record<string, SyncStatus>;
  onPull: (repo: CoworkRepository) => void;
  onDismiss: (repoId: string) => void;
  dismissedRepos: Set<string>;
  pullingRepoId?: string | null;
}

interface ItemProps {
  repo: CoworkRepository;
  status: SyncStatus;
  onPull: (repo: CoworkRepository) => void;
  onDismiss: (repoId: string) => void;
  pullingRepoId?: string | null;
}

function NotificationItem({ repo, status, onPull, onDismiss, pullingRepoId }: ItemProps) {
  const isPulling = pullingRepoId === repo.id;
  const isDiverged = status.state === 'diverged';

  useEffect(() => {
    if (isPulling) return; // don't auto-dismiss while pulling
    const timer = setTimeout(() => onDismiss(repo.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [repo.id, isPulling, onDismiss]);

  return (
    <div className={`cowork-notification ${isDiverged ? 'diverged' : 'behind'}`}>
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
          disabled={isPulling}
          style={{ opacity: isPulling ? 0.7 : 1, cursor: isPulling ? 'default' : 'pointer' }}
        >
          {isPulling ? '⏳ Pull…' : isDiverged ? 'Trotzdem Pull' : 'Pull'}
        </button>
        <button
          className="notification-btn dismiss"
          onClick={() => onDismiss(repo.id)}
          disabled={isPulling}
          title="Später"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default function CoworkNotification({
  repositories,
  syncStatus,
  onPull,
  onDismiss,
  dismissedRepos,
  pullingRepoId,
}: CoworkNotificationProps) {
  const behindRepos = repositories.filter((repo) => {
    const status = syncStatus[repo.id];
    if (!status) return false;
    if (dismissedRepos.has(repo.id)) return false;
    return status.state === 'behind' || status.state === 'diverged';
  });

  if (behindRepos.length === 0) return null;

  return (
    <div className="cowork-notification-container">
      {behindRepos.map((repo) => (
        <NotificationItem
          key={repo.id}
          repo={repo}
          status={syncStatus[repo.id]}
          onPull={onPull}
          onDismiss={onDismiss}
          pullingRepoId={pullingRepoId}
        />
      ))}
    </div>
  );
}
