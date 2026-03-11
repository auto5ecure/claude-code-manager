import { useState, useEffect } from 'react';
import type { CoworkRepository, SyncStatus } from '../../shared/types';

interface PreFlightModalProps {
  repository: CoworkRepository;
  onProceed: () => void;
  onPullAndProceed: () => void;
  onCancel: () => void;
}

interface LockInfo {
  locked: boolean;
  lock?: { user: string; machine: string; timestamp: string };
  isStale?: boolean;
  isOwnLock?: boolean;
  age?: number;
}

export default function PreFlightModal({
  repository,
  onProceed,
  onPullAndProceed,
  onCancel,
}: PreFlightModalProps) {
  const [step, setStep] = useState<'checking' | 'locked' | 'ready'>('checking');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [creatingLock, setCreatingLock] = useState(false);
  const [releasingLock, setReleasingLock] = useState(false);

  useEffect(() => {
    checkStatusAndLock();
  }, [repository]);

  async function checkStatusAndLock() {
    setStep('checking');
    setError(null);

    try {
      // First pull to get latest state (including lock file)
      await window.electronAPI?.coworkPull(
        repository.localPath,
        repository.remote,
        repository.branch
      );

      // Check for lock
      const lock = await window.electronAPI?.checkCoworkLock(repository.localPath);
      setLockInfo(lock || { locked: false });

      if (lock?.locked && !lock.isOwnLock) {
        setStep('locked');
        return;
      }

      // Check sync status
      const syncResult = await window.electronAPI?.getCoworkSyncStatus(
        repository.localPath,
        repository.remote,
        repository.branch
      );

      if (syncResult?.error) {
        setError(syncResult.error);
      } else {
        setStatus(syncResult || null);
      }

      setStep('ready');
    } catch (err) {
      setError((err as Error).message);
      setStep('ready');
    }
  }

  async function handleForceUnlock() {
    setReleasingLock(true);
    try {
      const result = await window.electronAPI?.forceReleaseCoworkLock(
        repository.localPath,
        repository.remote,
        repository.branch
      );
      if (result?.success) {
        setLockInfo({ locked: false });
        setStep('ready');
        // Re-check status
        const syncResult = await window.electronAPI?.getCoworkSyncStatus(
          repository.localPath,
          repository.remote,
          repository.branch
        );
        setStatus(syncResult || null);
      } else {
        setError(result?.error || 'Unlock fehlgeschlagen');
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setReleasingLock(false);
  }

  async function handleProceedWithLock() {
    setCreatingLock(true);
    try {
      const result = await window.electronAPI?.createCoworkLock(
        repository.localPath,
        repository.remote,
        repository.branch
      );
      if (result?.success) {
        onProceed();
      } else {
        setError(result?.error || 'Lock erstellen fehlgeschlagen');
        setCreatingLock(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setCreatingLock(false);
    }
  }

  async function handlePullAndProceedWithLock() {
    setPulling(true);
    try {
      const pullResult = await window.electronAPI?.coworkPull(
        repository.localPath,
        repository.remote,
        repository.branch
      );
      if (pullResult?.success) {
        await window.electronAPI?.updateCoworkLastSync(repository.id);
        // Now create lock and proceed
        const lockResult = await window.electronAPI?.createCoworkLock(
          repository.localPath,
          repository.remote,
          repository.branch
        );
        if (lockResult?.success) {
          onPullAndProceed();
        } else {
          setError(lockResult?.error || 'Lock erstellen fehlgeschlagen');
          setPulling(false);
        }
      } else {
        setError(pullResult?.error || 'Pull fehlgeschlagen');
        setPulling(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setPulling(false);
    }
  }

  function formatAge(minutes: number): string {
    if (minutes < 60) return `${minutes} Minuten`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} Stunde${hours !== 1 ? 'n' : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} Tag${days !== 1 ? 'en' : ''}`;
  }

  function getStatusDisplay() {
    if (!status) return null;

    switch (status.state) {
      case 'synced':
        return {
          icon: '✓',
          title: 'Synchronized',
          description: 'Repository ist aktuell.',
          className: 'synced',
          canProceed: true,
        };
      case 'behind':
        return {
          icon: '↓',
          title: `${status.behind} Commits hinter Remote`,
          description: 'Es gibt neue Änderungen. Pull empfohlen.',
          className: 'behind',
          canProceed: false,
          needsPull: true,
        };
      case 'ahead':
        // Handle case where ahead=0 but hasUncommittedChanges
        if (status.ahead === 0 && status.hasUncommittedChanges) {
          return {
            icon: '✎',
            title: 'Lokale Änderungen',
            description: 'Du hast nicht-committete Änderungen.',
            className: 'ahead',
            canProceed: true,
          };
        }
        return {
          icon: '↑',
          title: `${status.ahead} Commits voraus`,
          description: 'Du hast lokale Commits die noch nicht gepusht sind.',
          className: 'ahead',
          canProceed: true,
        };
      case 'diverged':
        return {
          icon: '⇅',
          title: 'Diverged',
          description: `${status.ahead} Commits voraus, ${status.behind} hinter Remote.`,
          className: 'diverged',
          canProceed: true,
          isWarning: true,
        };
      case 'conflict':
        return {
          icon: '!',
          title: 'Konflikt',
          description: 'Merge-Konflikte vorhanden. Bitte manuell lösen.',
          className: 'conflict',
          canProceed: false,
        };
      default:
        return null;
    }
  }

  const statusDisplay = getStatusDisplay();

  return (
    <div className="preflight-overlay" onClick={onCancel}>
      <div className="preflight-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preflight-header">
          <span>Pre-Flight Check</span>
          <button className="preflight-close" onClick={onCancel}>✕</button>
        </div>

        <div className="preflight-content">
          <div className="preflight-repo-info">
            <span className="preflight-repo-icon">📁</span>
            <div className="preflight-repo-details">
              <span className="preflight-repo-name">{repository.name}</span>
              <span className="preflight-repo-branch">{repository.remote}/{repository.branch}</span>
            </div>
          </div>

          {step === 'checking' && (
            <div className="preflight-checking">
              <div className="spinner"></div>
              <p>Prüfe Repository-Status und Lock...</p>
            </div>
          )}

          {step === 'locked' && lockInfo?.lock && (
            <div className="preflight-locked">
              <div className="lock-warning">
                <span className="lock-icon">🔒</span>
                <div className="lock-info">
                  <strong>Repository ist gesperrt!</strong>
                  <p>
                    <span className="lock-user">{lockInfo.lock.user}</span> arbeitet gerade
                    auf <span className="lock-machine">{lockInfo.lock.machine}</span>
                  </p>
                  <p className="lock-time">
                    Seit {formatAge(lockInfo.age || 0)}
                    {lockInfo.isStale && <span className="lock-stale"> (möglicherweise vergessen)</span>}
                  </p>
                </div>
              </div>

              {lockInfo.isStale && (
                <div className="lock-stale-notice">
                  Der Lock ist älter als 2 Stunden. Möglicherweise wurde vergessen ihn freizugeben.
                </div>
              )}

              {error && <div className="preflight-error">{error}</div>}
            </div>
          )}

          {step === 'ready' && (
            <>
              {statusDisplay && (
                <div className={`preflight-status ${statusDisplay.className}`}>
                  <span className="preflight-status-icon">{statusDisplay.icon}</span>
                  <div className="preflight-status-info">
                    <span className="preflight-status-title">{statusDisplay.title}</span>
                    <span className="preflight-status-desc">{statusDisplay.description}</span>
                  </div>
                </div>
              )}

              {status?.hasUncommittedChanges && (
                <div className="preflight-changes">
                  <span className="preflight-changes-title">Lokale Änderungen:</span>
                  <ul className="preflight-changes-list">
                    {status.changedFiles.slice(0, 5).map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                    {status.changedFiles.length > 5 && (
                      <li className="more">...und {status.changedFiles.length - 5} weitere</li>
                    )}
                  </ul>
                </div>
              )}

              <div className="preflight-lock-info">
                <span className="lock-icon-small">🔒</span>
                <span>Beim Start wird ein Lock erstellt und bei Beendigung freigegeben.</span>
              </div>

              {error && <div className="preflight-error">{error}</div>}
            </>
          )}
        </div>

        <div className="preflight-footer">
          <button className="btn-cancel" onClick={onCancel}>
            Abbrechen
          </button>

          {step === 'locked' && (
            <>
              {lockInfo?.isStale && (
                <button
                  className="btn-force-unlock"
                  onClick={handleForceUnlock}
                  disabled={releasingLock}
                >
                  {releasingLock ? 'Entsperre...' : 'Force Unlock'}
                </button>
              )}
              <button className="btn-cancel" onClick={checkStatusAndLock}>
                Erneut prüfen
              </button>
            </>
          )}

          {step === 'ready' && statusDisplay && (
            <>
              {statusDisplay.needsPull ? (
                <button
                  className="btn-pull"
                  onClick={handlePullAndProceedWithLock}
                  disabled={pulling}
                >
                  {pulling ? 'Pulling...' : 'Pull & Starten'}
                </button>
              ) : (
                <button
                  className="btn-proceed"
                  onClick={handleProceedWithLock}
                  disabled={creatingLock}
                >
                  {creatingLock ? 'Lock wird erstellt...' : 'Starten'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
