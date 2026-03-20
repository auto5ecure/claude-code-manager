import { useState, useEffect } from 'react';

interface PermissionCheckResult {
  chromeInstalled: boolean;
  chromePath?: string;
  canLaunchChrome: boolean;
  permissionError?: string;
  platform: string;
}

interface PermissionModalProps {
  onClose: () => void;
  onRetry: () => void;
}

export default function PermissionModal({ onClose, onRetry }: PermissionModalProps) {
  const [checking, setChecking] = useState(true);
  const [result, setResult] = useState<PermissionCheckResult | null>(null);

  useEffect(() => {
    checkPermissions();
  }, []);

  async function checkPermissions() {
    setChecking(true);
    const permResult = await window.electronAPI?.whatsappCheckPermissions();
    setResult(permResult || null);
    setChecking(false);
  }

  async function handleRetry() {
    await checkPermissions();
    if (result?.canLaunchChrome) {
      onRetry();
    }
  }

  function openSystemPreferences() {
    window.electronAPI?.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal permission-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Berechtigungen erforderlich</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-content">
          {checking ? (
            <div className="permission-checking">
              <div className="spinner" />
              <p>Prüfe Berechtigungen...</p>
            </div>
          ) : result ? (
            <div className="permission-result">
              {/* Chrome Installation Status */}
              <div className={`permission-item ${result.chromeInstalled ? 'ok' : 'error'}`}>
                <span className="permission-icon">{result.chromeInstalled ? '✓' : '✕'}</span>
                <div className="permission-info">
                  <span className="permission-title">Google Chrome</span>
                  <span className="permission-desc">
                    {result.chromeInstalled
                      ? result.chromePath
                      : 'Chrome ist nicht installiert. Bitte installiere Google Chrome.'}
                  </span>
                </div>
              </div>

              {/* Launch Permission Status */}
              {result.chromeInstalled && (
                <div className={`permission-item ${result.canLaunchChrome ? 'ok' : 'error'}`}>
                  <span className="permission-icon">{result.canLaunchChrome ? '✓' : '✕'}</span>
                  <div className="permission-info">
                    <span className="permission-title">Chrome starten</span>
                    <span className="permission-desc">
                      {result.canLaunchChrome
                        ? 'Chrome kann gestartet werden'
                        : result.permissionError || 'Chrome kann nicht gestartet werden'}
                    </span>
                  </div>
                </div>
              )}

              {/* Instructions for macOS */}
              {result.platform === 'darwin' && !result.canLaunchChrome && result.chromeInstalled && (
                <div className="permission-instructions">
                  <h3>So behebst du das Problem:</h3>
                  <ol>
                    <li>
                      Öffne <strong>Systemeinstellungen</strong>
                      <button className="btn-link" onClick={openSystemPreferences}>
                        Systemeinstellungen öffnen
                      </button>
                    </li>
                    <li>Gehe zu <strong>Datenschutz &amp; Sicherheit</strong></li>
                    <li>
                      Prüfe folgende Bereiche:
                      <ul>
                        <li><strong>Automation</strong> - Erlaube Claude MC, andere Apps zu steuern</li>
                        <li><strong>Vollständiger Festplattenzugriff</strong> - Optional, falls andere Methoden nicht helfen</li>
                      </ul>
                    </li>
                    <li>Falls eine Meldung erscheint, klicke auf <strong>Erlauben</strong></li>
                    <li>Starte Claude MC neu nach Änderungen</li>
                  </ol>

                  <div className="permission-hint">
                    <strong>Hinweis:</strong> Beim ersten Start von WhatsApp kann macOS eine
                    Sicherheitsmeldung anzeigen. Klicke auf "Erlauben" um fortzufahren.
                  </div>
                </div>
              )}

              {/* Chrome not installed instructions */}
              {!result.chromeInstalled && (
                <div className="permission-instructions">
                  <h3>Chrome installieren:</h3>
                  <ol>
                    <li>
                      Lade Google Chrome herunter:
                      <button
                        className="btn-link"
                        onClick={() => window.electronAPI?.openExternal('https://www.google.com/chrome/')}
                      >
                        chrome.google.com
                      </button>
                    </li>
                    <li>Installiere Chrome</li>
                    <li>Klicke auf "Erneut prüfen"</li>
                  </ol>
                </div>
              )}

              {/* Success state */}
              {result.canLaunchChrome && result.chromeInstalled && (
                <div className="permission-success">
                  <span className="success-icon">✓</span>
                  <p>Alle Berechtigungen sind vorhanden!</p>
                </div>
              )}
            </div>
          ) : (
            <div className="permission-error">
              <p>Fehler beim Prüfen der Berechtigungen.</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Schliessen</button>
          <button
            className="btn-primary"
            onClick={handleRetry}
            disabled={checking}
          >
            {checking ? 'Prüfe...' : 'Erneut prüfen'}
          </button>
        </div>
      </div>
    </div>
  );
}
