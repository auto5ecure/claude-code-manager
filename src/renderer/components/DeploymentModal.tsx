import { useState, useEffect } from 'react';
import type { DeploymentConfig, DeploymentStep, DeploymentResult } from '../../shared/types';

interface DeploymentModalProps {
  config: DeploymentConfig;
  onClose: () => void;
  onComplete: (result: DeploymentResult) => void;
}

export default function DeploymentModal({ config, onClose, onComplete }: DeploymentModalProps) {
  const [phase, setPhase] = useState<'confirm' | 'running' | 'success' | 'error'>('confirm');
  const [steps, setSteps] = useState<DeploymentStep[]>([]);
  const [result, setResult] = useState<DeploymentResult | null>(null);
  const [createBackup, setCreateBackup] = useState(true);

  useEffect(() => {
    // Listen for deployment progress
    const cleanup = window.electronAPI?.onDeploymentProgress((data) => {
      setSteps(data.steps);
    });
    return () => cleanup?.();
  }, []);

  async function handleDeploy() {
    setPhase('running');
    setSteps([
      { id: 'git-check', label: 'Git Status prüfen', status: 'pending' },
      { id: 'server-check', label: 'Server erreichbar', status: 'pending' },
      { id: 'backup', label: 'Backup erstellen', status: 'pending' },
      { id: 'transfer', label: 'Source übertragen', status: 'pending' },
      { id: 'build', label: 'Docker Build', status: 'pending' },
      { id: 'deploy', label: 'Container starten', status: 'pending' },
      { id: 'health', label: 'Health Check', status: 'pending' },
    ]);

    try {
      const deployResult = await window.electronAPI?.runDeployment(config);
      setResult(deployResult || { success: false, duration: 0, steps: [], error: 'Unknown error' });

      if (deployResult?.success) {
        setPhase('success');
      } else {
        setPhase('error');
      }
      onComplete(deployResult || { success: false, duration: 0, steps: [], error: 'Unknown error' });
    } catch (err) {
      const errorResult: DeploymentResult = {
        success: false,
        duration: 0,
        steps,
        error: (err as Error).message,
      };
      setResult(errorResult);
      setPhase('error');
      onComplete(errorResult);
    }
  }

  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0 ? `${minutes}:${remainingSeconds.toString().padStart(2, '0')} min` : `${seconds}s`;
  }

  function getStepIcon(status: DeploymentStep['status']): string {
    switch (status) {
      case 'pending': return '○';
      case 'running': return '⏳';
      case 'success': return '✓';
      case 'error': return '✗';
      default: return '?';
    }
  }

  return (
    <div className="deployment-modal-overlay" onClick={onClose}>
      <div className="deployment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="deployment-modal-header">
          <span>
            {phase === 'confirm' && 'Deployment starten'}
            {phase === 'running' && 'Deployment läuft...'}
            {phase === 'success' && 'Deployment erfolgreich!'}
            {phase === 'error' && 'Deployment fehlgeschlagen'}
          </span>
          {phase !== 'running' && (
            <button className="deployment-modal-close" onClick={onClose}>✕</button>
          )}
        </div>

        <div className="deployment-modal-content">
          {phase === 'confirm' && (
            <>
              <div className="deployment-confirm-info">
                <div className="deployment-confirm-row">
                  <span className="label">Projekt:</span>
                  <span className="value">{config.name}</span>
                </div>
                <div className="deployment-confirm-row">
                  <span className="label">Server:</span>
                  <span className="value">{config.server.host}</span>
                </div>
                <div className="deployment-confirm-row">
                  <span className="label">URL:</span>
                  <span className="value">{config.urls.production}</span>
                </div>
              </div>

              <div className="deployment-options">
                <label className="deployment-option">
                  <input
                    type="checkbox"
                    checked={createBackup}
                    onChange={(e) => setCreateBackup(e.target.checked)}
                  />
                  <span>Backup vor Deployment erstellen</span>
                </label>
              </div>

              <div className="deployment-warning">
                Das Deployment wird den aktuellen Stand auf den Production-Server übertragen.
                Stelle sicher, dass alle Änderungen getestet wurden.
              </div>
            </>
          )}

          {(phase === 'running' || phase === 'success' || phase === 'error') && (
            <div className="deployment-steps">
              {steps.map((step) => (
                <div key={step.id} className={`deployment-step ${step.status}`}>
                  <span className={`step-icon ${step.status}`}>
                    {getStepIcon(step.status)}
                  </span>
                  <span className="step-label">{step.label}</span>
                  {step.message && (
                    <span className="step-message">{step.message}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {phase === 'success' && result && (
            <div className="deployment-success-info">
              <div className="success-icon">✓</div>
              <div className="success-text">
                <span>Deployment abgeschlossen</span>
                <span className="success-duration">Dauer: {formatDuration(result.duration)}</span>
              </div>
              <a
                href={config.urls.production}
                target="_blank"
                rel="noopener noreferrer"
                className="success-link"
              >
                {config.urls.production} ↗
              </a>
            </div>
          )}

          {phase === 'error' && result && (
            <div className="deployment-error-info">
              <div className="error-icon">✗</div>
              <div className="error-text">
                <span>Deployment fehlgeschlagen</span>
                {result.error && <span className="error-message">{result.error}</span>}
              </div>
            </div>
          )}
        </div>

        <div className="deployment-modal-footer">
          {phase === 'confirm' && (
            <>
              <button className="btn-cancel" onClick={onClose}>
                Abbrechen
              </button>
              <button className="btn-deploy" onClick={handleDeploy}>
                Deploy starten
              </button>
            </>
          )}

          {phase === 'running' && (
            <div className="deployment-running-hint">
              Bitte warten, Deployment läuft...
            </div>
          )}

          {(phase === 'success' || phase === 'error') && (
            <button className="btn-close" onClick={onClose}>
              Schließen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
