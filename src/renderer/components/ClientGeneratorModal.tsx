import { useState, useEffect, useRef } from 'react';
import type { MDMCClient, MDMCSettings } from '../../shared/types';

interface Props {
  settings: MDMCSettings;
  onClose: () => void;
  onClientGenerated: (client: MDMCClient) => void;
}

type Step = 1 | 2 | 3;
type Platform = 'darwin' | 'linux' | 'windows' | 'android' | 'ios';

export default function ClientGeneratorModal({ settings, onClose, onClientGenerated }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Platform>('linux');
  const [wgServerId, setWgServerId] = useState(settings.wgServerId ?? '');
  const [servers, setServers] = useState<Array<{ id: string; name: string; host: string }>>([]);
  const [generating, setGenerating] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    client: MDMCClient;
    wgConf: string;
    agentJs: string;
    installSh: string;
    installPs1: string;
  } | null>(null);
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [qrCanvas, setQrCanvas] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    window.electronAPI?.getServers?.().then(svrs => {
      if (svrs) setServers(svrs.map(s => ({ id: s.id, name: s.name, host: s.host })));
    });
  }, []);

  // Generate QR code when we have wgConf
  useEffect(() => {
    if (!result?.wgConf) return;
    try {
      // Use qrcode library if available
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const QRCode = require('qrcode');
      QRCode.toDataURL(result.wgConf, { width: 200, margin: 2 }, (err: Error | null, url: string) => {
        if (!err) setQrCanvas(url);
      });
    } catch {
      // qrcode not available in renderer context
    }
  }, [result?.wgConf]);

  async function handleGenerate() {
    if (!name.trim()) { setError('Name ist erforderlich'); return; }
    if (!wgServerId) { setError('Bitte einen WG-Server auswählen'); return; }

    setError(null);
    setGenerating(true);
    setLog([]);
    setStep(2);

    const res = await window.electronAPI?.mdmcGenerateClient?.({ name: name.trim(), platform, wgServerId });

    setGenerating(false);
    if (!res) { setError('API nicht verfügbar'); return; }
    if (res.log) setLog(res.log);

    if (!res.success || !res.client) {
      setError(res.error ?? 'Unbekannter Fehler');
      return;
    }

    setResult({
      client: res.client,
      wgConf: res.wgConf ?? '',
      agentJs: res.agentJs ?? '',
      installSh: res.installSh ?? '',
      installPs1: res.installPs1 ?? '',
    });
    onClientGenerated(res.client);
    setStep(3);
  }

  function copyToClipboard(key: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(prev => ({ ...prev, [key]: true }));
    setTimeout(() => setCopied(prev => ({ ...prev, [key]: false })), 2000);
  }

  function downloadFile(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const platformLabel: Record<Platform, string> = {
    darwin: 'macOS',
    linux: 'Linux',
    windows: 'Windows',
    android: 'Android',
    ios: 'iOS',
  };

  const installInstructions: Record<Platform, string> = {
    darwin: `# macOS Installation

1. WireGuard installieren (falls nötig):
   brew install wireguard-tools

2. Skript ausführbar machen:
   chmod +x install.sh

3. Installer starten:
   ./install.sh

4. Danach startet der Agent automatisch.`,
    linux: `# Linux Installation

1. WireGuard installieren (falls nötig):
   sudo apt install wireguard   # Ubuntu/Debian
   sudo dnf install wireguard   # Fedora

2. Node.js installieren (falls nötig):
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt install -y nodejs

3. Skript ausführbar machen:
   chmod +x install.sh

4. Installer starten:
   ./install.sh`,
    windows: `# Windows Installation

1. Node.js installieren: https://nodejs.org
2. WireGuard installieren: https://www.wireguard.com/install/

3. PowerShell als Administrator öffnen und ausführen:
   .\\install.ps1

4. WireGuard-Config importieren:
   Öffne WireGuard App → "Tunnel hinzufügen" → wg-claudemc.conf`,
    android: `# Android Installation

1. WireGuard App installieren:
   Play Store → "WireGuard"

2. QR-Code scannen (WireGuard-Config):
   WireGuard App → + → QR-Code scannen

3. Node.js Agent (Termux):
   pkg install nodejs
   node agent.js`,
    ios: `# iOS Installation

1. WireGuard App installieren:
   App Store → "WireGuard"

2. QR-Code scannen (WireGuard-Config):
   WireGuard App → + → QR-Code scannen

3. Agent: Auf iOS ist ein nativer Agent
   derzeit nicht verfügbar. Nur WireGuard
   für Netzwerkzugang möglich.`,
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mdmc-generator-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, width: '90vw' }}>
        <div className="modal-header">
          <h3>Neuer MDMC Client</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Step Indicator */}
        <div className="mdmc-wizard-steps">
          {[1, 2, 3].map(s => (
            <div key={s} className={`mdmc-wizard-step ${step === s ? 'active' : step > s ? 'done' : ''}`}>
              <span className="mdmc-wizard-step-num">{step > s ? '✓' : s}</span>
              <span className="mdmc-wizard-step-label">
                {s === 1 ? 'Konfiguration' : s === 2 ? 'Generierung' : 'Download'}
              </span>
            </div>
          ))}
        </div>

        <div className="modal-body">
          {/* Step 1: Configuration */}
          {step === 1 && (
            <div className="mdmc-step-content">
              <div className="form-group">
                <label>Name des Clients</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="z.B. Büro-Mac, Raspberry Pi"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Platform</label>
                <select value={platform} onChange={e => setPlatform(e.target.value as Platform)}>
                  {(Object.keys(platformLabel) as Platform[]).map(p => (
                    <option key={p} value={p}>{platformLabel[p]}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>WireGuard-Server</label>
                {servers.length === 0 ? (
                  <div className="mdmc-no-servers">
                    Kein Server verfügbar. Bitte zuerst einen Server in ServerMC konfigurieren.
                  </div>
                ) : (
                  <select value={wgServerId} onChange={e => setWgServerId(e.target.value)}>
                    <option value="">— Server auswählen —</option>
                    {servers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                    ))}
                  </select>
                )}
              </div>
              {error && <div className="mdmc-error">{error}</div>}
            </div>
          )}

          {/* Step 2: Generation */}
          {step === 2 && (
            <div className="mdmc-step-content">
              <div className="mdmc-gen-log">
                {log.map((line, i) => (
                  <div key={i} className={`mdmc-gen-log-line ${line.startsWith('✓') ? 'success' : line.startsWith('✗') ? 'error' : ''}`}>
                    {line}
                  </div>
                ))}
                {generating && (
                  <div className="mdmc-gen-log-line loading">⏳ Verarbeite...</div>
                )}
                {error && (
                  <div className="mdmc-gen-log-line error">✗ Fehler: {error}</div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Download */}
          {step === 3 && result && (
            <div className="mdmc-step-content">
              <div className="mdmc-download-section">

                {/* ── Single bundled installer ── */}
                {platform !== 'windows' ? (
                  <div className="mdmc-installer-card">
                    <div className="mdmc-installer-icon">📦</div>
                    <div className="mdmc-installer-info">
                      <div className="mdmc-installer-name">install.sh</div>
                      <div className="mdmc-installer-desc">
                        Enthält WireGuard-Config + Agent – alles in einer Datei
                      </div>
                    </div>
                    <div className="mdmc-installer-actions">
                      <button className="btn-secondary btn-xs" onClick={() => copyToClipboard('sh', result.installSh)}>
                        {copied.sh ? '✓' : '📋'}
                      </button>
                      <button className="btn-primary btn-xs" onClick={() => downloadFile('install.sh', result.installSh)}>
                        ⬇ Download
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mdmc-installer-card">
                    <div className="mdmc-installer-icon">📦</div>
                    <div className="mdmc-installer-info">
                      <div className="mdmc-installer-name">install.ps1</div>
                      <div className="mdmc-installer-desc">
                        Enthält WireGuard-Config + Agent – alles in einer Datei
                      </div>
                    </div>
                    <div className="mdmc-installer-actions">
                      <button className="btn-secondary btn-xs" onClick={() => copyToClipboard('ps1', result.installPs1)}>
                        {copied.ps1 ? '✓' : '📋'}
                      </button>
                      <button className="btn-primary btn-xs" onClick={() => downloadFile('install.ps1', result.installPs1)}>
                        ⬇ Download
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Run command ── */}
                <div className="mdmc-run-command">
                  <div className="mdmc-run-command-label">Auf dem Zielgerät ausführen:</div>
                  {platform !== 'windows' ? (
                    <div className="mdmc-run-command-box">
                      <code>chmod +x install.sh && sudo ./install.sh</code>
                      <button className="mdmc-run-copy-btn" onClick={() => copyToClipboard('cmd', 'chmod +x install.sh && sudo ./install.sh')}>
                        {copied.cmd ? '✓' : '📋'}
                      </button>
                    </div>
                  ) : (
                    <div className="mdmc-run-command-box">
                      <code>Set-ExecutionPolicy Bypass -Scope Process; .\install.ps1</code>
                      <button className="mdmc-run-copy-btn" onClick={() => copyToClipboard('cmd', 'Set-ExecutionPolicy Bypass -Scope Process; .\\install.ps1')}>
                        {copied.cmd ? '✓' : '📋'}
                      </button>
                    </div>
                  )}
                </div>

                {/* ── QR Code for iOS/Android ── */}
                {(platform === 'android' || platform === 'ios') && qrCanvas && (
                  <div className="mdmc-qr-section">
                    <div className="mdmc-qr-label">WireGuard QR-Code</div>
                    <img src={qrCanvas} alt="WireGuard QR Code" className="mdmc-qr-image" />
                    <div className="mdmc-qr-hint">WireGuard App öffnen → + → QR scannen</div>
                  </div>
                )}

                {/* ── Platform notes ── */}
                <div className="mdmc-install-instructions">
                  <div className="mdmc-install-instructions-title">Was der Installer macht</div>
                  <pre className="mdmc-install-code">{`✓ Node.js prüfen → falls fehlt: auto-installieren
   ${platform === 'darwin' ? '(brew / nodejs.org pkg)' : platform === 'linux' ? '(apt / dnf / pacman / apk)' : platform === 'windows' ? '(winget / choco / MSI)' : ''}
✓ agent.js + WG-Config entpacken → ~/.claudemc-agent/
✓ ws npm-Paket installieren
✓ WireGuard prüfen → falls fehlt: auto-installieren
   ${platform === 'darwin' ? '(brew install wireguard-tools)' : platform === 'linux' ? '(apt / dnf / pacman / apk)' : platform === 'windows' ? '(winget / choco / direkter Download)' : ''}
✓ WireGuard-Tunnel starten
✓ Agent als ${platform === 'darwin' ? 'LaunchAgent einrichten (startet beim Login)' : platform === 'linux' ? 'systemd-Dienst einrichten' : platform === 'windows' ? 'Scheduled Task einrichten' : 'Prozess starten'}`}</pre>
                </div>
              </div>

              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === 1 && (
            <>
              <button className="btn-primary" onClick={handleGenerate} disabled={!name.trim() || !wgServerId}>
                Generieren →
              </button>
              <button className="btn-secondary" onClick={onClose}>Abbrechen</button>
            </>
          )}
          {step === 2 && !generating && error && (
            <>
              <button className="btn-secondary" onClick={() => { setStep(1); setError(null); }}>← Zurück</button>
              <button className="btn-secondary" onClick={onClose}>Schließen</button>
            </>
          )}
          {step === 2 && generating && (
            <button className="btn-secondary" disabled>Generiere...</button>
          )}
          {step === 3 && (
            <button className="btn-primary" onClick={onClose}>Fertig</button>
          )}
        </div>
      </div>
    </div>
  );
}
