import { useState, useEffect } from 'react';

interface WhatsAppConfig {
  enabled: boolean;
  allowedNumbers: string[];
  notifyNumbers: string[];
  autoReply: boolean;
}

interface WhatsAppStatus {
  connected: boolean;
  ready: boolean;
  phoneNumber?: string;
  error?: string;
}

interface WhatsAppModalProps {
  onClose: () => void;
}

export default function WhatsAppModal({ onClose }: WhatsAppModalProps) {
  const [status, setStatus] = useState<WhatsAppStatus>({ connected: false, ready: false });
  const [config, setConfig] = useState<WhatsAppConfig>({
    enabled: false,
    allowedNumbers: [],
    notifyNumbers: [],
    autoReply: true,
  });
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newAllowedNumber, setNewAllowedNumber] = useState('');
  const [newNotifyNumber, setNewNotifyNumber] = useState('');
  const [activeTab, setActiveTab] = useState<'status' | 'config'>('status');

  useEffect(() => {
    loadStatusAndConfig();

    // Listen for QR code updates
    const unsubQR = window.electronAPI?.onWhatsappQR((qrDataUrl) => {
      setQrCode(qrDataUrl);
      setLoading(false);
    });

    // Listen for status updates
    const unsubStatus = window.electronAPI?.onWhatsappStatus((newStatus) => {
      setStatus(newStatus);
      if (newStatus.ready) {
        setQrCode(null);
      }
    });

    return () => {
      unsubQR?.();
      unsubStatus?.();
    };
  }, []);

  async function loadStatusAndConfig() {
    const [statusResult, configResult] = await Promise.all([
      window.electronAPI?.whatsappStatus(),
      window.electronAPI?.whatsappGetConfig(),
    ]);
    if (statusResult) setStatus(statusResult);
    if (configResult) setConfig(configResult);
  }

  async function handleConnect() {
    setLoading(true);
    setQrCode(null);
    const result = await window.electronAPI?.whatsappInit();
    if (!result?.success) {
      setLoading(false);
      alert(result?.error || 'Verbindung fehlgeschlagen');
    }
  }

  async function handleDisconnect() {
    await window.electronAPI?.whatsappDisconnect();
    setStatus({ connected: false, ready: false });
    setQrCode(null);
  }

  async function handleLogout() {
    if (confirm('WhatsApp abmelden? Die Session wird gelöscht und du musst den QR-Code erneut scannen.')) {
      await window.electronAPI?.whatsappLogout();
      setStatus({ connected: false, ready: false });
      setQrCode(null);
    }
  }

  function handleAddAllowedNumber() {
    if (newAllowedNumber && !config.allowedNumbers.includes(newAllowedNumber)) {
      const updated = { ...config, allowedNumbers: [...config.allowedNumbers, newAllowedNumber] };
      setConfig(updated);
      window.electronAPI?.whatsappSaveConfig(updated);
      setNewAllowedNumber('');
    }
  }

  function handleRemoveAllowedNumber(number: string) {
    const updated = { ...config, allowedNumbers: config.allowedNumbers.filter(n => n !== number) };
    setConfig(updated);
    window.electronAPI?.whatsappSaveConfig(updated);
  }

  function handleAddNotifyNumber() {
    if (newNotifyNumber && !config.notifyNumbers.includes(newNotifyNumber)) {
      const updated = { ...config, notifyNumbers: [...config.notifyNumbers, newNotifyNumber] };
      setConfig(updated);
      window.electronAPI?.whatsappSaveConfig(updated);
      setNewNotifyNumber('');
    }
  }

  function handleRemoveNotifyNumber(number: string) {
    const updated = { ...config, notifyNumbers: config.notifyNumbers.filter(n => n !== number) };
    setConfig(updated);
    window.electronAPI?.whatsappSaveConfig(updated);
  }

  async function handleToggleEnabled(enabled: boolean) {
    const updated = { ...config, enabled };
    setConfig(updated);
    await window.electronAPI?.whatsappSaveConfig(updated);
  }

  async function handleToggleAutoReply(autoReply: boolean) {
    const updated = { ...config, autoReply };
    setConfig(updated);
    await window.electronAPI?.whatsappSaveConfig(updated);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal whatsapp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>WhatsApp Connector</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="whatsapp-tabs">
          <button
            className={`whatsapp-tab ${activeTab === 'status' ? 'active' : ''}`}
            onClick={() => setActiveTab('status')}
          >
            Status
          </button>
          <button
            className={`whatsapp-tab ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            Einstellungen
          </button>
        </div>

        <div className="modal-content">
          {activeTab === 'status' && (
            <div className="whatsapp-status-tab">
              <div className="whatsapp-status-indicator">
                <span className={`status-dot ${status.ready ? 'connected' : status.connected ? 'connecting' : 'disconnected'}`} />
                <span className="status-text">
                  {status.ready ? 'Verbunden' : status.connected ? 'Verbinde...' : 'Nicht verbunden'}
                </span>
                {status.phoneNumber && (
                  <span className="status-phone">+{status.phoneNumber}</span>
                )}
              </div>

              {status.error && (
                <div className="whatsapp-error">
                  {status.error}
                </div>
              )}

              {!status.ready && !qrCode && !loading && (
                <div className="whatsapp-connect-section">
                  <p>Verbinde WhatsApp Web um Nachrichten zu senden und zu empfangen.</p>
                  <button className="btn-primary" onClick={handleConnect}>
                    WhatsApp verbinden
                  </button>
                </div>
              )}

              {loading && !qrCode && (
                <div className="whatsapp-loading">
                  <div className="spinner" />
                  <p>Lade QR-Code...</p>
                </div>
              )}

              {qrCode && (
                <div className="whatsapp-qr-section">
                  <p>Scanne den QR-Code mit WhatsApp:</p>
                  <div className="qr-code-container">
                    <img src={qrCode} alt="WhatsApp QR Code" className="qr-code" />
                  </div>
                  <p className="qr-instructions">
                    WhatsApp öffnen → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen
                  </p>
                </div>
              )}

              {status.ready && (
                <div className="whatsapp-connected-section">
                  <div className="connected-info">
                    <span className="connected-icon">✓</span>
                    <span>WhatsApp ist verbunden und bereit</span>
                  </div>
                  <div className="whatsapp-actions">
                    <button className="btn-secondary" onClick={handleDisconnect}>
                      Trennen
                    </button>
                    <button className="btn-danger" onClick={handleLogout}>
                      Abmelden
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'config' && (
            <div className="whatsapp-config-tab">
              <div className="config-section">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => handleToggleEnabled(e.target.checked)}
                  />
                  <span className="toggle-label">
                    <span className="toggle-title">WhatsApp Notifications</span>
                    <span className="toggle-desc">Sende Claude-Benachrichtigungen auch an WhatsApp</span>
                  </span>
                </label>
              </div>

              <div className="config-section">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={config.autoReply}
                    onChange={(e) => handleToggleAutoReply(e.target.checked)}
                  />
                  <span className="toggle-label">
                    <span className="toggle-title">Auto-Reply</span>
                    <span className="toggle-desc">WhatsApp-Nachrichten automatisch an Claude weiterleiten</span>
                  </span>
                </label>
              </div>

              <div className="config-section">
                <h3>Benachrichtigungs-Nummern</h3>
                <p className="config-hint">Diese Nummern erhalten Claude-Benachrichtigungen (z.B. 4917612345678)</p>
                <div className="number-list">
                  {config.notifyNumbers.map((number) => (
                    <div key={number} className="number-item">
                      <span>+{number}</span>
                      <button onClick={() => handleRemoveNotifyNumber(number)}>✕</button>
                    </div>
                  ))}
                </div>
                <div className="number-input">
                  <input
                    type="text"
                    placeholder="4917612345678"
                    value={newNotifyNumber}
                    onChange={(e) => setNewNotifyNumber(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddNotifyNumber()}
                  />
                  <button onClick={handleAddNotifyNumber}>+</button>
                </div>
              </div>

              <div className="config-section">
                <h3>Erlaubte Absender</h3>
                <p className="config-hint">Nur diese Nummern können Befehle senden (leer = alle)</p>
                <div className="number-list">
                  {config.allowedNumbers.map((number) => (
                    <div key={number} className="number-item">
                      <span>+{number}</span>
                      <button onClick={() => handleRemoveAllowedNumber(number)}>✕</button>
                    </div>
                  ))}
                  {config.allowedNumbers.length === 0 && (
                    <div className="number-item empty">Alle Nummern erlaubt</div>
                  )}
                </div>
                <div className="number-input">
                  <input
                    type="text"
                    placeholder="4917612345678"
                    value={newAllowedNumber}
                    onChange={(e) => setNewAllowedNumber(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddAllowedNumber()}
                  />
                  <button onClick={handleAddAllowedNumber}>+</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Schliessen</button>
        </div>
      </div>
    </div>
  );
}
