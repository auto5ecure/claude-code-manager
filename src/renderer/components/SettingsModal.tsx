import { useState, useEffect } from 'react';
import type { GitHubAccount } from '../../shared/types';

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
      </div>
    </div>
  );
}
