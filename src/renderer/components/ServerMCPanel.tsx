import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import type { DeploymentConfig, MailAccount, MailMessage, ServerCredential } from '../../shared/types';
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
function CredentialsTab({ projects, onSshTerminal }: { projects: Project[]; onSshTerminal: (tabId: string, serverName: string) => void }) {
  const [servers, setServers] = useState<ServerCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ServerCredential | null | false>(false); // false=closed, null=new, ServerCredential=edit
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; msg: string }>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [claudeOpeningId, setClaudeOpeningId] = useState<string | null>(null);
  const [unleashedIds, setUnleashedIds] = useState<Set<string>>(new Set());

  const loadServers = useCallback(async () => {
    const list = await window.electronAPI?.getServers();
    setServers(list || []);
    setLoading(false);
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
    if (result?.tabId) onSshTerminal(result.tabId, result.serverName);
  }

  async function handleClaudeTerminal(server: ServerCredential) {
    setClaudeOpeningId(server.id);
    const result = await window.electronAPI?.claudeServerSession(server.id, unleashedIds.has(server.id));
    setClaudeOpeningId(null);
    if (result?.error) {
      setTestResults(prev => ({ ...prev, [server.id]: { success: false, msg: result.error! } }));
      return;
    }
    if (result?.tabId) onSshTerminal(result.tabId, `🤖 ${result.serverName}`);
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

  function authBadge(s: ServerCredential) {
    const items = [];
    if (s.authType === 'key' || s.authType === 'both') items.push('Key');
    if (s.authType === 'password' || s.authType === 'both') items.push('PW');
    return items.join('+');
  }

  return (
    <div className="smc-credentials">
      <div className="smc-cred-header">
        <span className="smc-sidebar-header" style={{ margin: 0 }}>Gespeicherte Server</span>
        <button className="btn-accent btn-sm" onClick={() => setModal(null)}>
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
          {servers.map(server => {
            const testR = testResults[server.id];
            return (
              <div key={server.id} className="smc-cred-item">
                <div className="smc-cred-row1">
                  <span className="smc-cred-name">{server.name}</span>
                  <div className="smc-cred-actions">
                    <button className="btn-secondary btn-sm" onClick={() => handleTest(server)} disabled={testingId === server.id} title="Verbindung testen">
                      {testingId === server.id ? <Loader size={12} className="spin" /> : <CheckCircle size={12} />}
                    </button>
                    <button className="btn-secondary btn-sm" onClick={() => setModal(server)} title="Bearbeiten"><Pencil size={12} /></button>
                    <button className="btn-secondary btn-sm smc-btn-danger" onClick={() => handleRemove(server)} title="Löschen"><Trash2 size={12} /></button>
                  </div>
                </div>
                <div className="smc-cred-row2">
                  <span className="smc-cred-host">{server.user}@{server.host}{server.port !== 22 ? `:${server.port}` : ''}</span>
                  <span className="smc-cred-auth-badge">{authBadge(server)}</span>
                  {server.projectIds.length > 0 && <span className="smc-cred-proj-count">{server.projectIds.length} Proj.</span>}
                  {server.notes && <span className="smc-cred-notes">{server.notes}</span>}
                  <label className="smc-unleashed-label" title="Claude ohne Bestätigungen starten">
                    <input type="checkbox" checked={unleashedIds.has(server.id)} onChange={(e) => setUnleashedIds(prev => { const n = new Set(prev); e.target.checked ? n.add(server.id) : n.delete(server.id); return n; })} />
                    Unleashed
                  </label>
                  <button className="btn-accent btn-sm" onClick={() => handleSshTerminal(server)} disabled={openingId === server.id} title="SSH Terminal">
                    {openingId === server.id ? <Loader size={12} className="spin" /> : <Terminal size={12} />}
                    SSH
                  </button>
                  <button className="btn-accent btn-sm" onClick={() => handleClaudeTerminal(server)} disabled={claudeOpeningId === server.id} title="Claude Console">
                    {claudeOpeningId === server.id ? <Loader size={12} className="spin" /> : <Bot size={12} />}
                    Claude
                  </button>
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
  onSshTerminal?: (tabId: string, serverName: string) => void;
}

export default function ServerMCPanel({ projects = [], onSshTerminal }: ServerMCPanelProps) {
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
          />
        )}
        {tab === 'server' && <ServerTab />}
        {tab === 'emails' && <EmailTab />}
      </div>
    </div>
  );
}
