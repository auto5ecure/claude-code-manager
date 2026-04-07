import { useState } from 'react';
import type { CoworkRepository, SyncStatus, DeploymentConfig } from '../../shared/types';

interface UnlockOptionsModalProps {
  repository: CoworkRepository;
  syncStatus: SyncStatus | undefined;
  deploymentConfig: DeploymentConfig | undefined;
  onPushAndClose: () => void;
  onJustClose: () => void;
  onPushDeployAndClose: () => void;
  onCancel: () => void;
}

export default function UnlockOptionsModal({
  repository,
  syncStatus,
  deploymentConfig,
  onPushAndClose,
  onJustClose,
  onPushDeployAndClose,
  onCancel,
}: UnlockOptionsModalProps) {
  const [loading, setLoading] = useState<string | null>(null);

  const hasChanges = syncStatus?.hasUncommittedChanges || false;
  const changedFilesCount = syncStatus?.changedFiles?.length || 0;

  async function handlePushAndClose() {
    setLoading('push');
    onPushAndClose();
  }

  async function handleJustClose() {
    setLoading('close');
    onJustClose();
  }

  async function handlePushDeployAndClose() {
    setLoading('deploy');
    onPushDeployAndClose();
  }

  return (
    <div className="unlock-modal-overlay" onClick={onCancel}>
      <div className="unlock-modal" onClick={(e) => e.stopPropagation()}>
        <div className="unlock-modal-header">
          <span>🔓 Force Unlock</span>
          <button className="unlock-modal-close" onClick={onCancel}>✕</button>
        </div>

        <div className="unlock-modal-content">
          <div className="unlock-repo-info">
            <span className="unlock-repo-icon">📁</span>
            <span className="unlock-repo-name">{repository.name}</span>
          </div>

          <div className="unlock-warning-box">
            <span className="warning-icon">⚠️</span>
            <span className="warning-text">
              <strong>Force Unlock</strong> - Falls jemand anderes noch arbeitet, können dessen nicht gepushte Änderungen verloren gehen!
            </span>
          </div>

          {hasChanges && (
            <div className="unlock-changes-warning">
              <span className="warning-icon">📝</span>
              <span>
                {changedFilesCount} uncommitted change{changedFilesCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          <div className="unlock-options">
            {/* Just Close */}
            <button
              className="unlock-option-btn secondary"
              onClick={handleJustClose}
              disabled={loading !== null}
            >
              {loading === 'close' ? (
                <span className="btn-loading">Schließe...</span>
              ) : (
                <>
                  <span className="option-icon">🔓</span>
                  <span className="option-text">
                    <strong>Nur schließen</strong>
                    <span className="option-desc">
                      {hasChanges
                        ? 'Änderungen bleiben lokal (nicht empfohlen)'
                        : 'Lock freigeben'}
                    </span>
                  </span>
                </>
              )}
            </button>

            {/* Push and Close */}
            {hasChanges && (
              <button
                className="unlock-option-btn primary"
                onClick={handlePushAndClose}
                disabled={loading !== null}
              >
                {loading === 'push' ? (
                  <span className="btn-loading">Pushe...</span>
                ) : (
                  <>
                    <span className="option-icon">↑</span>
                    <span className="option-text">
                      <strong>Pushen und schließen</strong>
                      <span className="option-desc">Commit & Push, dann Lock freigeben</span>
                    </span>
                  </>
                )}
              </button>
            )}

            {/* Push, Deploy and Close */}
            {hasChanges && deploymentConfig && (
              <button
                className="unlock-option-btn deploy"
                onClick={handlePushDeployAndClose}
                disabled={loading !== null}
              >
                {loading === 'deploy' ? (
                  <span className="btn-loading">Deploye...</span>
                ) : (
                  <>
                    <span className="option-icon">🚀</span>
                    <span className="option-text">
                      <strong>Pushen, Deployen und schließen</strong>
                      <span className="option-desc">Commit, Push, Deploy, dann Lock freigeben</span>
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
