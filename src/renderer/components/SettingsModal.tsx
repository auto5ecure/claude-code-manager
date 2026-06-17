import { useState, useEffect, useCallback } from 'react';
import type { GitHubAccount, TaskServerConnection } from '../../shared/types';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addUsername, setAddUsername] = useState('');
  const [addDisplayName, setAddDisplayName] = useState('');
  const [addToken, setAddToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; login?: string; error?: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notifTesting, setNotifTesting] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    const list = await window.electronAPI?.getGitHubAccounts?.();
    if (list) setAccounts(list);
  }

  async function handleSave() {
    if (!addUsername.trim()) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI?.saveGitHubAccount?.(
        { username: addUsername.trim(), displayName: addDisplayName.trim() || undefined },
        addToken.trim()
      );
      if (saved) {
        await loadAccounts();
        setShowAddForm(false);
        setAddUsername('');
        setAddDisplayName('');
        setAddToken('');
        setShowToken(false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(account: GitHubAccount) {
    setTestingId(account.id);
    try {
      const result = await window.electronAPI?.testGitHubAccount?.(account.id);
      if (result) {
        setTestResults(prev => ({ ...prev, [account.id]: { ok: result.success, login: result.login, error: result.error } }));
      }
    } finally {
      setTestingId(null);
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    try {
      await window.electronAPI?.removeGitHubAccount?.(id);
      setAccounts(prev => prev.filter(a => a.id !== id));
      setTestResults(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setRemovingId(null);
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // ─── Task-Server (single) ──────────────────────────────────────────────────
  const [taskServer, setTaskServer] = useState<TaskServerConnection | null>(null);
  const [tsName, setTsName] = useState('');
  const [tsBaseUrl, setTsBaseUrl] = useState('');
  const [tsToken, setTsToken] = useState('');
  const [tsShowToken, setTsShowToken] = useState(false);
  const [tsEditMode, setTsEditMode] = useState(false);
  const [tsSaving, setTsSaving] = useState(false);
  const [tsTestResult, setTsTestResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);

  const loadTaskServer = useCallback(async () => {
    const list = await window.electronAPI?.getTaskServers?.();
    const first = list?.[0] || null;
    setTaskServer(first);
    if (first) {
      setTsName(first.name);
      setTsBaseUrl(first.baseUrl);
    } else {
      setTsName('');
      setTsBaseUrl('http://10.0.0.9:4243');
      setTsEditMode(true); // show the form when empty
    }
  }, []);

  useEffect(() => { loadTaskServer(); }, [loadTaskServer]);

  async function handleTsSave() {
    if (!tsName.trim() || !tsBaseUrl.trim()) return;
    setTsSaving(true);
    try {
      await window.electronAPI?.saveTaskServer?.(
        { id: taskServer?.id, name: tsName.trim(), baseUrl: tsBaseUrl.trim() },
        tsToken ? tsToken.trim() : (taskServer ? undefined : ''),
      );
      setTsToken('');
      setTsShowToken(false);
      setTsEditMode(false);
      await loadTaskServer();
    } finally {
      setTsSaving(false);
    }
  }

  async function handleTsTest() {
    if (!taskServer) return;
    setTsTestResult({ ok: false, error: 'Teste...' });
    const r = await window.electronAPI?.testTaskServer?.(taskServer.id);
    if (r) setTsTestResult({ ok: !!r.success, version: r.version, error: r.error });
  }

  async function handleTsRemove() {
    if (!taskServer) return;
    if (!confirm(`Task-Server "${taskServer.name}" entfernen?`)) return;
    await window.electronAPI?.removeTaskServer?.(taskServer.id);
    setTaskServer(null);
    setTsTestResult(null);
    setTsName('');
    setTsBaseUrl('http://10.0.0.9:4243');
    setTsEditMode(true);
  }

  async function handleTestNotification() {
    setNotifTesting(true);
    setNotifResult(null);
    try {
      const res = await window.electronAPI?.sendTestNotification?.();
      if (!res) { setNotifResult('Kein Response — Preload-Bridge fehlt evtl.'); return; }
      if (!res.supported) { setNotifResult('System unterstützt keine Notifications'); return; }
      if (res.shown) {
        setNotifResult('✓ Gesendet. Wenn du nichts siehst: System-Einstellungen → Mitteilungen → Claude MC → „Mitteilungen erlauben" aktivieren.');
      } else {
        setNotifResult(`Fehler: ${res.error || 'unbekannt'}`);
      }
    } finally {
      setNotifTesting(false);
    }
  }

  return (
    <div className="stg-overlay" onClick={handleOverlayClick}>
      <div className="stg-modal" onClick={e => e.stopPropagation()}>
        <div className="stg-header">
          <span className="stg-title">Einstellungen</span>
          <button className="stg-close-btn" onClick={onClose} title="Schließen">✕</button>
        </div>

        {/* GitHub Accounts Section */}
        <div className="stg-section">
          <div className="stg-section-title">GitHub Accounts</div>
          <div className="stg-section-hint">
            PAT (Personal Access Token) hinterlegen – wird automatisch für Cowork-Operationen verwendet.
          </div>

          {accounts.length === 0 && !showAddForm && (
            <div className="stg-empty">Noch keine GitHub-Accounts.</div>
          )}

          {accounts.map(account => {
            const result = testResults[account.id];
            return (
              <div key={account.id} className="stg-gh-row">
                <span className="stg-gh-dot" />
                <span className="stg-gh-username">{account.username}</span>
                {account.displayName && (
                  <span className="stg-gh-display">({account.displayName})</span>
                )}
                {result && (
                  <span className={`stg-gh-badge ${result.ok ? 'ok' : 'err'}`}>
                    {result.ok ? `✓ ${result.login || account.username}` : `✗ ${result.error || 'Fehler'}`}
                  </span>
                )}
                <div className="stg-gh-actions">
                  <button
                    className="stg-gh-btn"
                    onClick={() => handleTest(account)}
                    disabled={testingId === account.id}
                    title="Verbindung testen"
                  >
                    {testingId === account.id ? '...' : 'Testen'}
                  </button>
                  <button
                    className="stg-gh-btn stg-gh-btn-remove"
                    onClick={() => handleRemove(account.id)}
                    disabled={removingId === account.id}
                    title="Entfernen"
                  >
                    {removingId === account.id ? '...' : '✕'}
                  </button>
                </div>
              </div>
            );
          })}

          {!showAddForm ? (
            <button className="stg-add-btn" onClick={() => setShowAddForm(true)}>
              + Konto hinzufügen
            </button>
          ) : (
            <div className="stg-add-form">
              <div className="stg-form-row">
                <label className="stg-label">Username</label>
                <input
                  className="stg-input"
                  type="text"
                  value={addUsername}
                  onChange={e => setAddUsername(e.target.value)}
                  placeholder="z.B. auto5ecure"
                  autoFocus
                />
              </div>
              <div className="stg-form-row">
                <label className="stg-label">Anzeigename</label>
                <input
                  className="stg-input"
                  type="text"
                  value={addDisplayName}
                  onChange={e => setAddDisplayName(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="stg-form-row">
                <label className="stg-label">Token (PAT)</label>
                <div className="stg-token-row">
                  <input
                    className="stg-input stg-token-input"
                    type={showToken ? 'text' : 'password'}
                    value={addToken}
                    onChange={e => setAddToken(e.target.value)}
                    placeholder="ghp_..."
                  />
                  <button
                    className="stg-token-toggle"
                    onClick={() => setShowToken(v => !v)}
                    title={showToken ? 'Verbergen' : 'Anzeigen'}
                  >
                    {showToken ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
              <div className="stg-form-actions">
                <button
                  className="stg-btn-primary"
                  onClick={handleSave}
                  disabled={saving || !addUsername.trim()}
                >
                  {saving ? 'Speichern...' : 'Speichern'}
                </button>
                <button
                  className="stg-btn-secondary"
                  onClick={() => {
                    setShowAddForm(false);
                    setAddUsername('');
                    setAddDisplayName('');
                    setAddToken('');
                    setShowToken(false);
                  }}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Task-Server Section (RTaskMC) — one server is enough */}
        <div className="stg-section">
          <div className="stg-section-title">Task-Server (RTaskMC)</div>
          <div className="stg-section-hint">
            VPS-Container der Shell-Tasks ausführt (siehe <code>task-server/README.md</code>). Token wird verschlüsselt im Vault gespeichert.
          </div>

          {taskServer && !tsEditMode && (
            <div className="stg-gh-row">
              <span className="stg-gh-dot" />
              <span className="stg-gh-username">{taskServer.name}</span>
              <span className="stg-gh-display">{taskServer.baseUrl}</span>
              {tsTestResult && (
                <span className={`stg-gh-badge ${tsTestResult.ok ? 'ok' : 'err'}`}>
                  {tsTestResult.ok ? `✓ v${tsTestResult.version || '?'}` : `✗ ${tsTestResult.error || 'Fehler'}`}
                </span>
              )}
              <div className="stg-gh-actions">
                <button className="stg-gh-btn" onClick={handleTsTest}>Testen</button>
                <button className="stg-gh-btn" onClick={() => setTsEditMode(true)}>Edit</button>
                <button className="stg-gh-btn stg-gh-btn-remove" onClick={handleTsRemove}>✕</button>
              </div>
            </div>
          )}

          {tsEditMode && (
            <div className="stg-add-form">
              <div className="stg-form-row">
                <label className="stg-label">Name</label>
                <input
                  className="stg-input"
                  type="text"
                  value={tsName}
                  onChange={e => setTsName(e.target.value)}
                  placeholder="z.B. N8N VPS"
                />
              </div>
              <div className="stg-form-row">
                <label className="stg-label">Base URL</label>
                <input
                  className="stg-input"
                  type="text"
                  value={tsBaseUrl}
                  onChange={e => setTsBaseUrl(e.target.value)}
                  placeholder="http://10.0.0.9:4243"
                />
              </div>
              <div className="stg-form-row">
                <label className="stg-label">Token {taskServer && '(leer = unverändert)'}</label>
                <div className="stg-token-row">
                  <input
                    className="stg-input stg-token-input"
                    type={tsShowToken ? 'text' : 'password'}
                    value={tsToken}
                    onChange={e => setTsToken(e.target.value)}
                    placeholder={taskServer?.hasToken ? '••••••••' : 'API_KEY vom Server'}
                  />
                  <button className="stg-token-toggle" onClick={() => setTsShowToken(v => !v)}>
                    {tsShowToken ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
              <div className="stg-form-actions">
                <button
                  className="stg-btn-primary"
                  onClick={handleTsSave}
                  disabled={tsSaving || !tsName.trim() || !tsBaseUrl.trim()}
                >
                  {tsSaving ? 'Speichern...' : 'Speichern'}
                </button>
                {taskServer && (
                  <button className="stg-btn-secondary" onClick={() => { setTsEditMode(false); setTsToken(''); setTsShowToken(false); }}>
                    Abbrechen
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Desktop Notifications Section */}
        <div className="stg-section">
          <div className="stg-section-title">Desktop-Benachrichtigungen</div>
          <div className="stg-section-hint">
            Claude MC sendet Notifications bei Patterns wie „wartet auf Eingabe" oder „Task abgeschlossen", solange das Fenster nicht im Vordergrund ist.
            Falls noch nie Notifications kamen: erst hier testen — macOS fragt beim ersten Mal nach Erlaubnis.
          </div>
          <div className="stg-notif-row">
            <button
              className="stg-gh-btn primary"
              onClick={handleTestNotification}
              disabled={notifTesting}
            >
              {notifTesting ? 'Sende …' : '🔔 Test-Notification senden'}
            </button>
            <button
              className="stg-gh-btn"
              onClick={() => window.electronAPI?.openExternal?.('x-apple.systempreferences:com.apple.preference.notifications')}
              title="macOS System-Einstellungen → Mitteilungen"
            >
              ⚙ macOS-Einstellungen öffnen
            </button>
          </div>
          {notifResult && (
            <div className="stg-section-hint" style={{ marginTop: 8 }}>{notifResult}</div>
          )}
        </div>
      </div>
    </div>
  );
}
