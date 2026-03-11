import { useState } from 'react';

interface AddCoworkRepoModalProps {
  onAdd: (repo: {
    name: string;
    localPath: string;
    githubUrl: string;
    remote: string;
    branch: string;
  }) => void;
  onCancel: () => void;
}

type Step = 'input' | 'validating' | 'results' | 'cloning';

interface ValidationResult {
  valid: boolean;
  needsClone: boolean;
  localPath: string;
  repoName: string;
  error?: string;
  isGitRepo?: boolean;
  remoteMatch?: boolean;
  currentRemoteUrl?: string;
  detectedRemote?: string;
  detectedBranch?: string;
  syncStatus?: {
    state: string;
    ahead: number;
    behind: number;
    hasUncommittedChanges: boolean;
    changedFiles: string[];
  };
}

export default function AddCoworkRepoModal({ onAdd, onCancel }: AddCoworkRepoModalProps) {
  const [step, setStep] = useState<Step>('input');
  const [githubUrl, setGithubUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [useCustomPath, setUseCustomPath] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [cloneProgress, setCloneProgress] = useState('');

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
    if (files.length > 0 && files[0].path) {
      setLocalPath(files[0].path);
      setUseCustomPath(true);
    }
  }

  async function handleValidate() {
    setError('');

    if (!githubUrl.trim()) {
      setError('GitHub URL ist erforderlich');
      return;
    }

    // Basic URL validation
    if (!githubUrl.includes('github.com/')) {
      setError('Bitte eine gültige GitHub URL eingeben');
      return;
    }

    setStep('validating');

    try {
      const result = await window.electronAPI?.validateCoworkRepository(
        githubUrl.trim(),
        useCustomPath && localPath.trim() ? localPath.trim() : undefined
      );

      if (result) {
        setValidation(result);
        setStep('results');
      } else {
        setError('Validierung fehlgeschlagen');
        setStep('input');
      }
    } catch (err) {
      setError((err as Error).message);
      setStep('input');
    }
  }

  async function handleClone() {
    if (!validation) return;

    setStep('cloning');
    setCloneProgress('Repository wird geklont...');

    try {
      const result = await window.electronAPI?.cloneCoworkRepository(
        githubUrl.trim(),
        validation.localPath
      );

      if (result?.success) {
        setCloneProgress('Erfolgreich geklont!');
        // Re-validate to get sync status and detected branch/remote
        const revalidation = await window.electronAPI?.validateCoworkRepository(
          githubUrl.trim(),
          validation.localPath
        );
        if (revalidation) {
          setValidation(revalidation);
        }
        setStep('results');
      } else {
        setError(result?.error || 'Clone fehlgeschlagen');
        setStep('results');
      }
    } catch (err) {
      setError((err as Error).message);
      setStep('results');
    }
  }

  function handleAdd() {
    if (!validation) return;

    onAdd({
      name: validation.repoName,
      localPath: validation.localPath,
      githubUrl: githubUrl.trim(),
      remote: validation.detectedRemote || 'origin',
      branch: validation.detectedBranch || 'main',
    });
  }

  function getSyncStatusDisplay(status: ValidationResult['syncStatus']) {
    if (!status) return null;

    const badges: Record<string, { icon: string; text: string; className: string }> = {
      synced: { icon: '✓', text: 'Synchronized', className: 'synced' },
      behind: { icon: '↓', text: `${status.behind} Commits hinter Remote`, className: 'behind' },
      ahead: { icon: '↑', text: `${status.ahead} Commits voraus`, className: 'ahead' },
      diverged: { icon: '⇅', text: `${status.ahead}↑ ${status.behind}↓ Diverged`, className: 'diverged' },
      conflict: { icon: '!', text: 'Konflikt', className: 'conflict' },
    };

    return badges[status.state] || { icon: '?', text: 'Unbekannt', className: 'unknown' };
  }

  return (
    <div className="cowork-modal-overlay" onClick={onCancel}>
      <div className="cowork-modal cowork-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="cowork-modal-header">
          <span>Cowork-Repository hinzufügen</span>
          <button className="cowork-modal-close" onClick={onCancel}>✕</button>
        </div>

        {step === 'input' && (
          <>
            <div className="cowork-modal-content">
              <div className="form-group">
                <label htmlFor="github-url">GitHub URL *</label>
                <input
                  id="github-url"
                  type="text"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label className="checkbox-label-inline">
                  <input
                    type="checkbox"
                    checked={useCustomPath}
                    onChange={(e) => setUseCustomPath(e.target.checked)}
                  />
                  <span>Eigenen lokalen Pfad verwenden</span>
                </label>
              </div>

              {useCustomPath && (
                <div className="form-group">
                  <label htmlFor="local-path">Lokaler Pfad</label>
                  <div
                    className={`path-drop-zone ${isDragging ? 'dragging' : ''}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="path-input-row">
                      <input
                        id="local-path"
                        type="text"
                        value={localPath}
                        onChange={(e) => setLocalPath(e.target.value)}
                        placeholder="Ordner hierher ziehen oder Pfad eingeben"
                      />
                      <button
                        type="button"
                        className="browse-btn"
                        onClick={async () => {
                          const folderPath = await window.electronAPI?.selectProjectFolder();
                          if (folderPath) {
                            setLocalPath(folderPath);
                          }
                        }}
                      >
                        Auswählen...
                      </button>
                    </div>
                    {isDragging && <div className="drop-hint">Hier ablegen</div>}
                  </div>
                </div>
              )}

              {!useCustomPath && (
                <div className="info-box">
                  Das Repository wird automatisch in den Cowork-Ordner geklont, falls es lokal nicht existiert.
                </div>
              )}

              {error && <div className="form-error">{error}</div>}
            </div>

            <div className="cowork-modal-footer">
              <button type="button" className="btn-cancel" onClick={onCancel}>
                Abbrechen
              </button>
              <button type="button" className="btn-add" onClick={handleValidate}>
                Prüfen →
              </button>
            </div>
          </>
        )}

        {step === 'validating' && (
          <div className="cowork-modal-content">
            <div className="validation-loading">
              <div className="spinner"></div>
              <p>Repository wird geprüft...</p>
              <p className="validation-substep">Verbinde mit GitHub und prüfe lokales Repository</p>
            </div>
          </div>
        )}

        {step === 'cloning' && (
          <div className="cowork-modal-content">
            <div className="validation-loading">
              <div className="spinner"></div>
              <p>{cloneProgress}</p>
              <p className="validation-substep">Dies kann einen Moment dauern...</p>
            </div>
          </div>
        )}

        {step === 'results' && validation && (
          <>
            <div className="cowork-modal-content">
              <div className="validation-results">
                <div className="validation-header">
                  <span className={`validation-icon ${validation.valid && !validation.needsClone ? 'success' : validation.needsClone ? 'warning' : 'error'}`}>
                    {validation.valid && !validation.needsClone ? '✓' : validation.needsClone ? '↓' : '✗'}
                  </span>
                  <div className="validation-title">
                    <strong>{validation.repoName}</strong>
                    <span className="validation-url">{githubUrl}</span>
                  </div>
                </div>

                <div className="validation-details">
                  <div className="validation-row">
                    <span className="validation-label">Lokaler Pfad:</span>
                    <span className="validation-value mono">{validation.localPath}</span>
                  </div>

                  {validation.needsClone ? (
                    <div className="validation-row">
                      <span className="validation-label">Status:</span>
                      <span className="validation-value">
                        <span className="status-badge warning">Muss geklont werden</span>
                      </span>
                    </div>
                  ) : validation.isGitRepo ? (
                    <>
                      <div className="validation-row">
                        <span className="validation-label">Git Repository:</span>
                        <span className="validation-value">
                          <span className="status-badge success">✓ Gültig</span>
                        </span>
                      </div>

                      {validation.detectedRemote && validation.detectedBranch && (
                        <div className="validation-row">
                          <span className="validation-label">Branch:</span>
                          <span className="validation-value">
                            <span className="branch-badge">{validation.detectedRemote}/{validation.detectedBranch}</span>
                          </span>
                        </div>
                      )}

                      {validation.syncStatus && (
                        <div className="validation-row">
                          <span className="validation-label">Sync Status:</span>
                          <span className="validation-value">
                            <span className={`status-badge ${getSyncStatusDisplay(validation.syncStatus)?.className}`}>
                              {getSyncStatusDisplay(validation.syncStatus)?.icon} {getSyncStatusDisplay(validation.syncStatus)?.text}
                            </span>
                          </span>
                        </div>
                      )}

                      {validation.syncStatus?.hasUncommittedChanges && (
                        <div className="validation-row">
                          <span className="validation-label">Lokale Änderungen:</span>
                          <span className="validation-value warning-text">
                            {validation.syncStatus.changedFiles.length} Datei(en)
                          </span>
                        </div>
                      )}
                    </>
                  ) : null}

                  {validation.error && (
                    <div className="validation-error">
                      {validation.error}
                    </div>
                  )}
                </div>

                {error && <div className="form-error">{error}</div>}
              </div>
            </div>

            <div className="cowork-modal-footer">
              <button type="button" className="btn-cancel" onClick={() => { setStep('input'); setError(''); }}>
                ← Zurück
              </button>
              {validation.needsClone ? (
                <button type="button" className="btn-clone" onClick={handleClone}>
                  Repository klonen
                </button>
              ) : validation.valid ? (
                <button type="button" className="btn-add" onClick={handleAdd}>
                  Hinzufügen
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
