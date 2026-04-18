import { useState, useEffect, useCallback } from 'react';
import type { MDMCClient, ClientSysInfo, MDMCSettings } from '../../shared/types';
import ClientGeneratorModal from './ClientGeneratorModal';

interface MDMCPanelProps {
  onOpenTerminal: (tabId: string, clientName: string) => void;
}

type RightPanel = 'sysinfo' | 'info';

export default function MDMCPanel({ onOpenTerminal }: MDMCPanelProps) {
  const [clients, setClients] = useState<MDMCClient[]>([]);
  const [settings, setSettings] = useState<MDMCSettings>({
    wsPort: 4242,
    macWgIp: '10.0.0.2',
    wgInterface: 'wg0',
    wgSubnet: '10.0.0.0/24',
    nextIpIndex: 10,
  });
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [sysinfoMap, setSysinfoMap] = useState<Record<string, ClientSysInfo>>({});
  const [rightPanel, setRightPanel] = useState<RightPanel>('sysinfo');
  const [showSettings, setShowSettings] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [editSettings, setEditSettings] = useState<MDMCSettings | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [cs, st, ids] = await Promise.all([
      window.electronAPI?.mdmcGetClients?.() ?? [],
      window.electronAPI?.mdmcGetSettings?.(),
      window.electronAPI?.mdmcGetConnected?.() ?? [],
    ]);
    if (cs) setClients(cs);
    if (st) setSettings(st);
    setConnectedIds(new Set(ids ?? []));
  }, []);

  useEffect(() => {
    loadData();
    // Listen for MDMC events
    const unsub = window.electronAPI?.onMDMCEvent?.((e) => {
      if (e.type === 'client-connected' || e.type === 'client-disconnected') {
        window.electronAPI?.mdmcGetConnected?.().then(ids => {
          setConnectedIds(new Set(ids ?? []));
        });
      }
      if (e.type === 'sysinfo-updated') {
        const info = e.data as ClientSysInfo;
        setSysinfoMap(prev => ({ ...prev, [e.clientId]: info }));
      }
    });
    return () => unsub?.();
  }, [loadData]);

  // Start server on mount and get port
  useEffect(() => {
    window.electronAPI?.mdmcStartServer?.().then(res => {
      if (res?.success) setServerPort(res.port);
    });
  }, []);

  // Poll sysinfo for selected client
  useEffect(() => {
    if (!selectedClientId) return;
    const poll = async () => {
      const info = await window.electronAPI?.mdmcGetSysinfo?.(selectedClientId);
      if (info) setSysinfoMap(prev => ({ ...prev, [selectedClientId]: info }));
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, [selectedClientId]);

  const selectedClient = clients.find(c => c.id === selectedClientId) ?? null;
  const isConnected = selectedClientId ? connectedIds.has(selectedClientId) : false;
  const sysinfo = selectedClientId ? sysinfoMap[selectedClientId] : null;

  async function handleOpenTerminal() {
    if (!selectedClientId || !selectedClient) return;
    const res = await window.electronAPI?.mdmcOpenTerminal?.(selectedClientId);
    if (res?.error) {
      alert(`Terminal-Fehler: ${res.error}`);
      return;
    }
    if (res?.tabId) {
      onOpenTerminal(res.tabId, selectedClient.name);
    }
  }

  async function handleDeleteClient(client: MDMCClient) {
    if (!confirm(`Client "${client.name}" wirklich löschen? WireGuard-Peer wird entfernt.`)) return;
    setDeletingId(client.id);
    await window.electronAPI?.mdmcDeleteClient?.(client.id);
    setDeletingId(null);
    if (selectedClientId === client.id) setSelectedClientId(null);
    loadData();
  }

  async function handleSaveSettings() {
    if (!editSettings) return;
    const saved = await window.electronAPI?.mdmcSaveSettings?.(editSettings);
    if (saved) setSettings(saved);
    setShowSettings(false);
  }

  function handleClientGenerated(client: MDMCClient) {
    setClients(prev => [...prev, client]);
    setSelectedClientId(client.id);
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function platformIcon(platform: string): string {
    switch (platform) {
      case 'darwin': return '🍎';
      case 'linux': return '🐧';
      case 'windows': return '🪟';
      case 'android': return '🤖';
      case 'ios': return '📱';
      default: return '💻';
    }
  }

  return (
    <div className="mdmc-panel">
      {/* Header */}
      <div className="mdmc-header">
        <div className="mdmc-header-left">
          <h2 className="mdmc-title">MDMC</h2>
          <span className={`mdmc-server-status ${serverPort ? 'running' : 'stopped'}`}>
            {serverPort ? `● Port ${serverPort}` : '○ Server gestoppt'}
          </span>
        </div>
        <div className="mdmc-header-right">
          <button className="btn-secondary btn-sm" onClick={() => { setEditSettings({ ...settings }); setShowSettings(true); }}>
            ⚙ Einstellungen
          </button>
          <button className="btn-primary btn-sm" onClick={() => setShowGenerator(true)}>
            + Client
          </button>
        </div>
      </div>

      <div className="mdmc-body">
        {/* Left: Client List */}
        <div className="mdmc-client-list">
          {clients.length === 0 ? (
            <div className="mdmc-empty">
              <div className="mdmc-empty-icon">📡</div>
              <div>Noch keine Clients</div>
              <div className="mdmc-empty-hint">Klicke „+ Client" um einen neuen Remote-Client einzurichten</div>
            </div>
          ) : (
            clients.map(client => {
              const online = connectedIds.has(client.id);
              const info = sysinfoMap[client.id];
              return (
                <div
                  key={client.id}
                  className={`mdmc-client-item ${selectedClientId === client.id ? 'selected' : ''} ${online ? 'online' : 'offline'}`}
                  onClick={() => setSelectedClientId(client.id)}
                >
                  <div className="mdmc-client-status-dot" title={online ? 'Online' : 'Offline'} />
                  <div className="mdmc-client-info">
                    <div className="mdmc-client-name">
                      <span>{platformIcon(client.platform)}</span>
                      <span>{client.name}</span>
                    </div>
                    <div className="mdmc-client-meta">
                      {client.platform} · {client.wgIp}
                    </div>
                    {info?.battery !== undefined && (
                      <div className="mdmc-client-battery">🔋 {info.battery}%</div>
                    )}
                    {!online && <div className="mdmc-client-offline-label">Nicht verbunden</div>}
                    {online && info && (
                      <div className="mdmc-client-mini-stats">
                        CPU {info.cpu}% · RAM {Math.round(info.mem.used / 1024)}GB
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right: Detail Panel */}
        <div className="mdmc-detail">
          {!selectedClient ? (
            <div className="mdmc-detail-empty">
              <div>Kein Client ausgewählt</div>
            </div>
          ) : (
            <>
              {/* Detail Header */}
              <div className="mdmc-detail-header">
                <div className="mdmc-detail-name">
                  <span>{platformIcon(selectedClient.platform)}</span>
                  <span>{selectedClient.name}</span>
                  <span className={`mdmc-badge ${isConnected ? 'online' : 'offline'}`}>
                    {isConnected ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div className="mdmc-detail-actions">
                  <button
                    className="btn-secondary btn-sm"
                    disabled={!isConnected}
                    onClick={handleOpenTerminal}
                    title={!isConnected ? 'Client nicht verbunden' : 'Terminal öffnen'}
                  >
                    ⬛ Terminal
                  </button>
                  <button
                    className="btn-danger btn-sm"
                    disabled={deletingId === selectedClient.id}
                    onClick={() => handleDeleteClient(selectedClient)}
                  >
                    {deletingId === selectedClient.id ? '...' : '🗑 Löschen'}
                  </button>
                </div>
              </div>

              {/* Tab Bar */}
              <div className="mdmc-tab-bar">
                <button className={`mdmc-tab ${rightPanel === 'sysinfo' ? 'active' : ''}`} onClick={() => setRightPanel('sysinfo')}>
                  Sysinfo
                </button>
                <button className={`mdmc-tab ${rightPanel === 'info' ? 'active' : ''}`} onClick={() => setRightPanel('info')}>
                  Info
                </button>
              </div>

              {/* Sysinfo Panel */}
              {rightPanel === 'sysinfo' && (
                <div className="mdmc-sysinfo">
                  {!isConnected && (
                    <div className="mdmc-sysinfo-offline">Client ist nicht verbunden. Sysinfo nicht verfügbar.</div>
                  )}
                  {isConnected && !sysinfo && (
                    <div className="mdmc-sysinfo-loading">Warte auf Sysinfo...</div>
                  )}
                  {sysinfo && (
                    <>
                      <div className="mdmc-sysinfo-row">
                        <span className="mdmc-sysinfo-label">Hostname</span>
                        <span className="mdmc-sysinfo-value">{sysinfo.hostname}</span>
                      </div>
                      <div className="mdmc-sysinfo-row">
                        <span className="mdmc-sysinfo-label">OS</span>
                        <span className="mdmc-sysinfo-value">{sysinfo.os}</span>
                      </div>
                      <div className="mdmc-sysinfo-row">
                        <span className="mdmc-sysinfo-label">Uptime</span>
                        <span className="mdmc-sysinfo-value">{formatUptime(sysinfo.uptime)}</span>
                      </div>
                      {sysinfo.battery !== undefined && (
                        <div className="mdmc-sysinfo-row">
                          <span className="mdmc-sysinfo-label">Akku</span>
                          <span className="mdmc-sysinfo-value">{sysinfo.battery}%</span>
                        </div>
                      )}

                      <div className="mdmc-sysinfo-metric">
                        <div className="mdmc-sysinfo-metric-header">
                          <span>CPU</span>
                          <span>{sysinfo.cpu}%</span>
                        </div>
                        <div className="mdmc-progress-bar">
                          <div className="mdmc-progress-fill" style={{ width: `${sysinfo.cpu}%`, backgroundColor: sysinfo.cpu > 80 ? 'var(--color-error)' : 'var(--color-accent)' }} />
                        </div>
                      </div>

                      <div className="mdmc-sysinfo-metric">
                        <div className="mdmc-sysinfo-metric-header">
                          <span>RAM</span>
                          <span>{Math.round(sysinfo.mem.used / 1024 * 10) / 10} / {Math.round(sysinfo.mem.total / 1024 * 10) / 10} GB</span>
                        </div>
                        <div className="mdmc-progress-bar">
                          <div className="mdmc-progress-fill" style={{ width: `${Math.min(100, sysinfo.mem.total > 0 ? (sysinfo.mem.used / sysinfo.mem.total) * 100 : 0)}%` }} />
                        </div>
                      </div>

                      {sysinfo.disk.map((d, i) => (
                        <div key={i} className="mdmc-sysinfo-metric">
                          <div className="mdmc-sysinfo-metric-header">
                            <span>Disk {d.mount}</span>
                            <span>{d.used} / {d.total} GB</span>
                          </div>
                          <div className="mdmc-progress-bar">
                            <div className="mdmc-progress-fill" style={{ width: `${Math.min(100, d.total > 0 ? (d.used / d.total) * 100 : 0)}%` }} />
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* Info Panel */}
              {rightPanel === 'info' && (
                <div className="mdmc-info">
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">Client ID</span>
                    <span className="mdmc-info-value mono">{selectedClient.id}</span>
                  </div>
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">Platform</span>
                    <span className="mdmc-info-value">{selectedClient.platform}</span>
                  </div>
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">WireGuard IP</span>
                    <span className="mdmc-info-value mono">{selectedClient.wgIp}</span>
                  </div>
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">WG Interface</span>
                    <span className="mdmc-info-value mono">{selectedClient.wgInterface}</span>
                  </div>
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">Public Key</span>
                    <span className="mdmc-info-value mono" style={{ wordBreak: 'break-all', fontSize: '0.8em' }}>{selectedClient.wgPubKey}</span>
                  </div>
                  <div className="mdmc-info-row">
                    <span className="mdmc-info-label">Erstellt</span>
                    <span className="mdmc-info-value">{new Date(selectedClient.createdAt).toLocaleString('de-DE')}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && editSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>MDMC Einstellungen</h3>
              <button className="modal-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Mac WireGuard-IP</label>
                <input
                  type="text"
                  value={editSettings.macWgIp}
                  onChange={e => setEditSettings(s => s ? { ...s, macWgIp: e.target.value } : s)}
                  placeholder="10.0.0.2"
                />
              </div>
              <div className="form-group">
                <label>WebSocket-Port</label>
                <input
                  type="number"
                  value={editSettings.wsPort}
                  onChange={e => setEditSettings(s => s ? { ...s, wsPort: parseInt(e.target.value) || 4242 } : s)}
                />
              </div>
              <div className="form-group">
                <label>WG Interface</label>
                <input
                  type="text"
                  value={editSettings.wgInterface}
                  onChange={e => setEditSettings(s => s ? { ...s, wgInterface: e.target.value } : s)}
                  placeholder="wg0"
                />
              </div>
              <div className="form-group">
                <label>WG Subnet</label>
                <input
                  type="text"
                  value={editSettings.wgSubnet}
                  onChange={e => setEditSettings(s => s ? { ...s, wgSubnet: e.target.value } : s)}
                  placeholder="10.0.0.0/24"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={handleSaveSettings}>Speichern</button>
              <button className="btn-secondary" onClick={() => setShowSettings(false)}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}

      {/* Client Generator Modal */}
      {showGenerator && (
        <ClientGeneratorModal
          settings={settings}
          onClose={() => setShowGenerator(false)}
          onClientGenerated={handleClientGenerated}
        />
      )}
    </div>
  );
}
