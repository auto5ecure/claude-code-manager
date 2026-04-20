import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Server,
  Mail,
  RefreshCw,
  Box,
  Loader,
  CheckCircle,
  XCircle,
  AlertCircle,
  Inbox,
  Terminal,
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  Bot,
  Search,
  ChevronDown,
  Zap,
} from 'lucide-react';
import type { DeploymentConfig, MailAccount, MailMessage, ServerCredential, ServerSysinfo } from '../../shared/types';
import ServerCredentialModal from './ServerCredentialModal';

declare global {
  interface Window {
    electronAPI: import('../../main/preload').ElectronAPI;
  }
}

type TabId = 'credentials' | 'server' | 'emails';

interface DockerContainer { name: string; status: string; ports: string; image: string; }

interface Project { id: string; name: string; }

// ── Credentials Tab ───────────────────────────────────────────────────────────
function CredentialsTab({ projects, onSshTerminal, openServerIds }: { projects: Project[]; onSshTerminal: (tabId: string, serverName: string, serverId?: string) => void; openServerIds?: Set<string> }) {
  const [servers, setServers] = useState<ServerCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ServerCredential | null | false>(false); // false=closed, null=new, ServerCredential=edit
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; msg: string }>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [claudeOpeningId, setClaudeOpeningId] = useState<string | null>(null);
  const [dropdownId, setDropdownId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sysinfo state
  const [sysinfoMap, setSysinfoMap] = useState<Record<string, ServerSysinfo>>({});
  const [fetchingInfoId, setFetchingInfoId] = useState<string | null>(null);

  // Purpose inline edit state
  const [purposeEdit, setPurposeEdit] = useState<Record<string, string>>({});
  const [purposeEditing, setPurposeEditing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!dropdownId) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setDropdownId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownId]);

  const loadServers = useCallback(async () => {
    const list = await window.electronAPI?.getServers();
    setServers(list || []);
    setLoading(false);
    // Load cached sysinfo; auto-fetch live data if no cache exists
    for (const s of (list || [])) {
      window.electronAPI?.loadServerSysinfo(s.id).then(info => {
        if (info) {
          setSysinfoMap(prev => ({ ...prev, [s.id]: info as ServerSysinfo }));
        } else {
          // No cache – fetch live in background
          window.electronAPI?.fetchServerSysinfo(s.id).then(live => {
            if (live && !('error' in live)) {
              setSysinfoMap(prev => ({ ...prev, [s.id]: live as ServerSysinfo }));
            }
          }).catch(() => { /* ignore */ });
        }
      }).catch(() => { /* ignore */ });
    }
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  async function handleTest(server: ServerCredential) {
    setTestingId(server.id);
    const result = await window.electronAPI?.testServerConnection(server.id);
    setTestResults(prev => ({ ...prev, [server.id]: { success: result?.success || false, msg: result?.output || result?.error || '?' } }));
    setTestingId(null);
  }

  async function handleSshTerminal(server: ServerCredential) {
    setOpeningId(server.id);
    const result = await window.electronAPI?.sshOpenTerminal(server.id);
    setOpeningId(null);
    if (result?.error) {
      setTestResults(prev => ({ ...prev, [server.id]: { success: false, msg: result.error! } }));
      return;
    }
    if (result?.tabId) onSshTerminal(result.tabId, `🖥 ${result.serverName}`, server.id);
  }

  async function handleClaudeTerminal(server: ServerCredential, unleashed: boolean) {
    setClaudeOpeningId(server.id);
    const result = await window.electronAPI?.claudeServerSession(server.id, unleashed);
    setClaudeOpeningId(null);
    if (result?.error) {
      setTestResults(prev => ({ ...prev, [server.id]: { success: false, msg: result.error! } }));
      return;
    }
    if (result?.tabId) onSshTerminal(result.tabId, `🤖 ${result.serverName}`, server.id);
  }

  async function handleRemove(server: ServerCredential) {
    if (!confirm(`Server "${server.name}" löschen?`)) return;
    await window.electronAPI?.removeServer(server.id);
    setServers(prev => prev.filter(s => s.id !== server.id));
  }

  function handleSaved(saved: ServerCredential) {
    setServers(prev => {
      const idx = prev.findIndex(s => s.id === saved.id);
      if (idx !== -1) { const next = [...prev]; next[idx] = saved; return next; }
      return [...prev, saved];
    });
    setModal(false);
  }

  async function handleFetchSysinfo(server: ServerCredential) {
    setFetchingInfoId(server.id);
    const result = await window.electronAPI?.fetchServerSysinfo(server.id);
    setFetchingInfoId(null);
    if (result && !('error' in result)) {
      setSysinfoMap(prev => ({ ...prev, [server.id]: result as ServerSysinfo }));
    } else if (result && 'error' in result) {
      setTestResults(prev => ({ ...prev, [server.id]: { success: false, msg: (result as { error: string }).error } }));
    }
  }

  async function handlePurposeSave(server: ServerCredential) {
    const newPurpose = purposeEdit[server.id] ?? server.purpose ?? '';
    await window.electronAPI?.saveServerPurpose(server.id, newPurpose);
    setServers(prev => prev.map(s => s.id === server.id ? { ...s, purpose: newPurpose } : s));
    setPurposeEditing(prev => ({ ...prev, [server.id]: false }));
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatMem(mb: number): string {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb} MB`;
  }

  function authBadge(s: ServerCredential) {
    const items = [];
    if (s.authType === 'key' || s.authType === 'both') items.push('Key');
    if (s.authType === 'password' || s.authType === 'both') items.push('PW');
    return items.join('+');
  }

  const filtered = query.trim()
    ? servers.filter(s => `${s.name} ${s.host} ${s.user} ${s.purpose || ''}`.toLowerCase().includes(query.toLowerCase()))
    : servers;

  return (
    <div className="smc-credentials">
      <div className="smc-cred-header">
        <span className="smc-sidebar-header" style={{ margin: 0, flexShrink: 0 }}>Server</span>
        <div className="smc-cred-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Suchen…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <button className="btn-accent btn-sm" onClick={() => setModal(null)} style={{ flexShrink: 0 }}>
          <Plus size={13} /> Neu
        </button>
      </div>

      {loading ? (
        <div className="smc-center"><Loader size={18} className="spin" /></div>
      ) : servers.length === 0 ? (
        <div className="smc-empty-hint" style={{ textAlign: 'center', marginTop: 40 }}>
          <KeyRound size={32} style={{ opacity: 0.2, display: 'block', margin: '0 auto 8px' }} />
          Noch keine Server gespeichert.<br />Klicke "+ Neu" um einen Server hinzuzufügen.
        </div>
      ) : (
        <div className="smc-cred-list">
          {filtered.map(server => {
            const testR = testResults[server.id];
            const sysinfo = sysinfoMap[server.id];
            const isEditingPurpose = purposeEditing[server.id];
            const currentPurpose = server.purpose || '';
            return (
              <div key={server.id} className="smc-cred-item">
                <div className="smc-cred-row1">
                  <span className="smc-cred-name">{server.name}</span>
                  {openServerIds?.has(server.id) && <span className="tab-open-dot" title="Terminal offen" />}
                  <span className="smc-cred-auth-badge">{authBadge(server)}</span>
                  <span className="smc-cred-host">{server.user}@{server.host}{server.port !== 22 ? `:${server.port}` : ''}</span>
                  {server.projectIds.length > 0 && <span className="smc-cred-proj-count">{server.projectIds.length} Proj.</span>}
                  <div className="smc-cred-actions">
                    <button className="btn-accent btn-sm" onClick={() => handleSshTerminal(server)} disabled={openingId === server.id} title="SSH Terminal">
                      {openingId === server.id ? <Loader size={12} className="spin" /> : <Terminal size={12} />}
                      SSH
                    </button>
                    <div className="smc-claude-dropdown" ref={dropdownId === server.id ? dropdownRef : undefined}>
                      <button className="btn-accent btn-sm smc-claude-main" onClick={() => handleClaudeTerminal(server, false)} disabled={claudeOpeningId === server.id} title="Claude Console">
                        {claudeOpeningId === server.id ? <Loader size={12} className="spin" /> : <Bot size={12} />}
                        Claude
                      </button>
                      <button className="btn-accent btn-sm smc-claude-arrow" onClick={() => setDropdownId(dropdownId === server.id ? null : server.id)} disabled={claudeOpeningId === server.id}>
                        <ChevronDown size={11} />
                      </button>
                      {dropdownId === server.id && (
                        <div className="smc-claude-menu">
                          <button onClick={() => { handleClaudeTerminal(server, false); setDropdownId(null); }}>
                            <Bot size={12} /> Claude
                          </button>
                          <button onClick={() => { handleClaudeTerminal(server, true); setDropdownId(null); }}>
                            <Zap size={12} /> Claude Unleashed
                          </button>
                        </div>
                      )}
                    </div>
                    <button className="btn-secondary btn-sm" onClick={() => handleTest(server)} disabled={testingId === server.id} title="Verbindung testen">
                      {testingId === server.id ? <Loader size={12} className="spin" /> : <CheckCircle size={12} />}
                    </button>
                    <button className="btn-secondary btn-sm" onClick={() => setModal(server)} title="Bearbeiten"><Pencil size={12} /></button>
                    <button className="btn-secondary btn-sm smc-btn-danger" onClick={() => handleRemove(server)} title="Löschen"><Trash2 size={12} /></button>
                  </div>
                </div>

                {/* Sysinfo row */}
                <div className="smc-sysinfo-row">
                  {sysinfo ? (
                    <>
                      <span className="smc-sysinfo-stat">CPU {sysinfo.cpu}%</span>
                      <span className="smc-sysinfo-sep">·</span>
                      <span className="smc-sysinfo-stat">RAM {formatMem(sysinfo.mem.used)}/{formatMem(sysinfo.mem.total)}</span>
                      <span className="smc-sysinfo-sep">·</span>
                      <span className="smc-sysinfo-stat">Disk {sysinfo.disk.used}/{sysinfo.disk.total} GB</span>
                      <span className="smc-sysinfo-sep">·</span>
                      <span className="smc-sysinfo-stat">{sysinfo.os}</span>
                      <span className="smc-sysinfo-sep">·</span>
                      <span className="smc-sysinfo-stat">↑ {formatUptime(sysinfo.uptime)}</span>
                    </>
                  ) : (
                    <span className="smc-sysinfo-stat" style={{ opacity: 0.4 }}>CPU — · RAM — · Disk —</span>
                  )}
                  <button
                    className="smc-refresh-btn"
                    onClick={() => handleFetchSysinfo(server)}
                    disabled={fetchingInfoId === server.id}
                    title="Sysinfo aktualisieren"
                  >
                    {fetchingInfoId === server.id ? <Loader size={11} className="spin" /> : <RefreshCw size={11} />}
                  </button>
                </div>

                {/* Purpose row */}
                <div className="smc-purpose-row">
                  <span className="smc-sysinfo-stat" style={{ opacity: 0.5, flexShrink: 0 }}>Zweck:</span>
                  {isEditingPurpose ? (
                    <>
                      <input
                        className="smc-purpose-input"
                        value={purposeEdit[server.id] ?? currentPurpose}
                        onChange={e => setPurposeEdit(prev => ({ ...prev, [server.id]: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handlePurposeSave(server);
                          if (e.key === 'Escape') setPurposeEditing(prev => ({ ...prev, [server.id]: false }));
                        }}
                        onBlur={() => handlePurposeSave(server)}
                        autoFocus
                        placeholder="z.B. Webserver, Postgres, Nginx"
                      />
                    </>
                  ) : (
                    <span
                      className="smc-purpose-text"
                      onClick={() => {
                        setPurposeEdit(prev => ({ ...prev, [server.id]: currentPurpose }));
                        setPurposeEditing(prev => ({ ...prev, [server.id]: true }));
                      }}
                      title="Klicken zum Bearbeiten"
                    >
                      {currentPurpose || <span style={{ opacity: 0.35 }}>Klicken um Zweck einzutragen…</span>}
                    </span>
                  )}
                </div>

                {testR && (
                  <div className={`smc-cred-test-result ${testR.success ? 'success' : 'error'}`}>
                    {testR.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
                    <span>{testR.msg}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal !== false && (
        <ServerCredentialModal
          server={modal}
          projects={projects}
          onSave={handleSaved}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  );
}

// ── Server Tab ────────────────────────────────────────────────────────────────
function ServerTab() {
  const [configs, setConfigs] = useState<DeploymentConfig[]>([]);
  const [selected, setSelected] = useState<DeploymentConfig | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loadingDocker, setLoadingDocker] = useState(false);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [loadingConfigs, setLoadingConfigs] = useState(true);

  useEffect(() => {
    window.electronAPI.getDeploymentConfigs().then(c => {
      setConfigs(c);
      setLoadingConfigs(false);
    });
  }, []);

  async function fetchDocker(cfg: DeploymentConfig) {
    setSelected(cfg);
    setLoadingDocker(true);
    setDockerError(null);
    setContainers([]);
    const result = await window.electronAPI.getServerDockerStatus(
      cfg.server.host, cfg.server.user, cfg.server.sshKeyPath
    );
    if (result.success && result.containers) {
      setContainers(result.containers);
    } else {
      setDockerError(result.error ?? 'Unbekannter Fehler');
    }
    setLoadingDocker(false);
  }

  function statusColor(status: string) {
    const s = status.toLowerCase();
    if (s.startsWith('up')) return 'var(--success)';
    if (s.includes('exited') || s.includes('dead')) return 'var(--error, #ef4444)';
    return 'var(--text-secondary)';
  }

  return (
    <div className="smc-split">
      {/* Left: Server List */}
      <div className="smc-sidebar">
        <div className="smc-sidebar-header">Server</div>
        {loadingConfigs ? (
          <div className="smc-center"><Loader size={18} className="spin" /></div>
        ) : configs.length === 0 ? (
          <div className="smc-empty-hint">Keine Deployment-Configs.<br />Füge Server in CoworkMC → Deployment hinzu.</div>
        ) : (
          configs.map(cfg => (
            <button
              key={cfg.id}
              className={`smc-server-item ${selected?.id === cfg.id ? 'active' : ''}`}
              onClick={() => fetchDocker(cfg)}
            >
              <Server size={14} />
              <div className="smc-server-info">
                <span className="smc-server-name">{cfg.name}</span>
                <span className="smc-server-host">{cfg.server.user}@{cfg.server.host}</span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Right: Docker Status */}
      <div className="smc-content">
        {!selected ? (
          <div className="smc-center smc-placeholder">
            <Server size={36} style={{ opacity: 0.2 }} />
            <span>Server auswählen</span>
          </div>
        ) : loadingDocker ? (
          <div className="smc-center">
            <Loader size={22} className="spin" />
            <span style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
              docker ps …
            </span>
          </div>
        ) : dockerError ? (
          <div className="smc-center smc-error">
            <XCircle size={22} />
            <span>{dockerError}</span>
            <button className="btn-secondary btn-sm" onClick={() => fetchDocker(selected)}>
              <RefreshCw size={13} /> Erneut versuchen
            </button>
          </div>
        ) : (
          <>
            <div className="smc-content-header">
              <span><Box size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />{selected.server.host}</span>
              <button className="btn-secondary btn-sm" onClick={() => fetchDocker(selected)}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            {containers.length === 0 ? (
              <div className="smc-center" style={{ marginTop: 40 }}>
                <AlertCircle size={20} style={{ opacity: 0.4 }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Keine Container aktiv</span>
              </div>
            ) : (
              <div className="smc-table-wrap">
                <table className="smc-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Image</th>
                      <th>Ports</th>
                    </tr>
                  </thead>
                  <tbody>
                    {containers.map((c, i) => (
                      <tr key={i}>
                        <td className="smc-td-mono">{c.name}</td>
                        <td>
                          <span style={{ color: statusColor(c.status), fontSize: 12 }}>
                            {c.status.startsWith('Up') ? <CheckCircle size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> : null}
                            {c.status}
                          </span>
                        </td>
                        <td className="smc-td-mono smc-td-muted">{c.image}</td>
                        <td className="smc-td-mono smc-td-muted">{c.ports || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Email Tab ─────────────────────────────────────────────────────────────────
function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 86400000) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * 86400000) return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return dateStr; }
}

function EmailTab() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [selected, setSelected] = useState<MailAccount | null>(null);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingMail, setLoadingMail] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getMailAccounts().then(a => {
      setAccounts(a);
      setLoadingAccounts(false);
    });
  }, []);

  async function fetchMessages(acc: MailAccount) {
    setSelected(acc);
    setLoadingMail(true);
    setMailError(null);
    setMessages([]);
    const result = await window.electronAPI.fetchMailMessages(acc, 30);
    if (result.success && result.messages) {
      setMessages(result.messages);
      setTotal(result.total ?? 0);
    } else {
      setMailError(result.error ?? 'Unbekannter Fehler');
    }
    setLoadingMail(false);
  }

  return (
    <div className="smc-split">
      {/* Left: Account List */}
      <div className="smc-sidebar">
        <div className="smc-sidebar-header">Konten</div>
        {loadingAccounts ? (
          <div className="smc-center"><Loader size={18} className="spin" /></div>
        ) : accounts.length === 0 ? (
          <div className="smc-empty-hint">Keine Mail-Konten.<br />Konten in EmailMC konfigurieren.</div>
        ) : (
          accounts.map(acc => (
            <button
              key={acc.id}
              className={`smc-server-item ${selected?.id === acc.id ? 'active' : ''}`}
              onClick={() => fetchMessages(acc)}
            >
              <Mail size={14} />
              <div className="smc-server-info">
                <span className="smc-server-name">{acc.name}</span>
                <span className="smc-server-host">{acc.user}</span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Right: Message List */}
      <div className="smc-content">
        {!selected ? (
          <div className="smc-center smc-placeholder">
            <Inbox size={36} style={{ opacity: 0.2 }} />
            <span>Konto auswählen</span>
          </div>
        ) : loadingMail ? (
          <div className="smc-center">
            <Loader size={22} className="spin" />
            <span style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 13 }}>Lade Nachrichten …</span>
          </div>
        ) : mailError ? (
          <div className="smc-center smc-error">
            <XCircle size={22} />
            <span>{mailError}</span>
            <button className="btn-secondary btn-sm" onClick={() => fetchMessages(selected)}>
              <RefreshCw size={13} /> Erneut versuchen
            </button>
          </div>
        ) : (
          <>
            <div className="smc-content-header">
              <span>
                <Inbox size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {selected.name} – {selected.folder}
                {total > 0 && <span className="smc-total-badge">{total}</span>}
              </span>
              <button className="btn-secondary btn-sm" onClick={() => fetchMessages(selected)}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            {messages.length === 0 ? (
              <div className="smc-center" style={{ marginTop: 40 }}>
                <CheckCircle size={20} style={{ opacity: 0.4 }} />
                <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Keine Nachrichten</span>
              </div>
            ) : (
              <div className="smc-mail-list">
                {messages.map(msg => (
                  <div key={msg.uid} className={`smc-mail-item ${msg.seen ? 'seen' : 'unseen'}`}>
                    <div className="smc-mail-dot" />
                    <div className="smc-mail-body">
                      <div className="smc-mail-row">
                        <span className="smc-mail-from">{msg.from}</span>
                        <span className="smc-mail-date">{formatDate(msg.date)}</span>
                      </div>
                      <div className="smc-mail-subject">{msg.subject}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
interface ServerMCPanelProps {
  projects?: Project[];
  onSshTerminal?: (tabId: string, serverName: string, serverId?: string) => void;
  openServerIds?: Set<string>;
}

export default function ServerMCPanel({ projects = [], onSshTerminal, openServerIds }: ServerMCPanelProps) {
  const [tab, setTab] = useState<TabId>('credentials');

  return (
    <div className="panel-view servermc-panel">
      <div className="panel-header">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Server size={18} />
          <span>ServerMC</span>
        </div>
        <div className="smc-tab-bar">
          <button
            className={`smc-tab ${tab === 'credentials' ? 'active' : ''}`}
            onClick={() => setTab('credentials')}
          >
            <KeyRound size={13} /> Zugangsdaten
          </button>
          <button
            className={`smc-tab ${tab === 'server' ? 'active' : ''}`}
            onClick={() => setTab('server')}
          >
            <Server size={13} /> Docker
          </button>
          <button
            className={`smc-tab ${tab === 'emails' ? 'active' : ''}`}
            onClick={() => setTab('emails')}
          >
            <Mail size={13} /> Emails
          </button>
        </div>
      </div>

      <div className="smc-body">
        {tab === 'credentials' && (
          <CredentialsTab
            projects={projects}
            onSshTerminal={onSshTerminal || (() => {})}
            openServerIds={openServerIds}
          />
        )}
        {tab === 'server' && <ServerTab />}
        {tab === 'emails' && <EmailTab />}
      </div>
    </div>
  );
}
