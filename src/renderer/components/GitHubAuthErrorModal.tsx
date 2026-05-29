import { useEffect, useState } from 'react';

interface GhAccount {
  username: string;
  scopes: string[];
  active: boolean;
}

interface GitHubAuthErrorModalProps {
  owner?: string;
  repo?: string;
  errorMessage?: string;
  onClose: () => void;
  onResolved?: (newAccountUsername: string) => void;
}

export default function GitHubAuthErrorModal({ owner, repo, errorMessage, onClose, onResolved }: GitHubAuthErrorModalProps) {
  const [ghAccounts, setGhAccounts] = useState<GhAccount[]>([]);
  const [tokenInput, setTokenInput] = useState('');
  const [usernameInput, setUsernameInput] = useState(owner || '');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState<string | null>(null); // username being saved
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI?.ghCliListAccounts().then(setGhAccounts).catch(() => setGhAccounts([]));
  }, []);

  // Show matching gh accounts first (case-insensitive match on org)
  const matchingGh = owner ? ghAccounts.filter(a => a.username.toLowerCase() === owner.toLowerCase()) : [];
  const otherGh = ghAccounts.filter(a => !matchingGh.includes(a));

  async function importFromGh(username: string) {
    setSaving(username);
    setError(null);
    try {
      const tokenRes = await window.electronAPI?.ghCliGetToken(username);
      if (!tokenRes?.token) {
        setError(tokenRes?.error || 'Token konnte nicht aus gh CLI gelesen werden');
        return;
      }
      await window.electronAPI?.saveGitHubAccount?.({ username }, tokenRes.token);
      onResolved?.(username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function saveManual() {
    if (!usernameInput.trim() || !tokenInput.trim()) {
      setError('Username und Token sind Pflicht');
      return;
    }
    setSaving(usernameInput.trim());
    setError(null);
    try {
      await window.electronAPI?.saveGitHubAccount?.({ username: usernameInput.trim() }, tokenInput.trim());
      onResolved?.(usernameInput.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal gh-auth-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🔒 GitHub-Auth erforderlich</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="gh-auth-target">
            {owner && repo ? (
              <>Zugriff fehlt auf <code>{owner}/{repo}</code></>
            ) : (
              <>Git-Auth ist fehlgeschlagen.</>
            )}
          </div>
          {errorMessage && (
            <details className="gh-auth-error-details">
              <summary>Originale Fehlermeldung</summary>
              <pre>{errorMessage}</pre>
            </details>
          )}

          {matchingGh.length > 0 && (
            <>
              <div className="gh-auth-section-title">✓ Passendes Konto in gh CLI gefunden</div>
              {matchingGh.map(acc => (
                <button
                  key={acc.username}
                  className="gh-auth-import-btn primary"
                  disabled={saving === acc.username}
                  onClick={() => importFromGh(acc.username)}
                >
                  {saving === acc.username ? '...' : `↓ Aus gh übernehmen: ${acc.username}`}
                  <span className="gh-auth-scopes">scopes: {acc.scopes.join(', ') || '—'}</span>
                </button>
              ))}
            </>
          )}

          {otherGh.length > 0 && (
            <>
              <div className="gh-auth-section-title">Andere gh-Konten</div>
              {otherGh.map(acc => (
                <button
                  key={acc.username}
                  className="gh-auth-import-btn"
                  disabled={saving === acc.username}
                  onClick={() => importFromGh(acc.username)}
                >
                  {saving === acc.username ? '...' : `↓ Übernehmen: ${acc.username}`}
                </button>
              ))}
            </>
          )}

          <div className="gh-auth-section-title">Oder Token manuell eingeben</div>
          <div className="gh-auth-form">
            <label className="modal-label">GitHub Username (Org-Name)</label>
            <input
              className="modal-input"
              type="text"
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              placeholder={owner || 'z.B. auto5ecure'}
            />
            <label className="modal-label">Personal Access Token (PAT)</label>
            <div className="gh-auth-token-row">
              <input
                className="modal-input"
                type={showToken ? 'text' : 'password'}
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder="ghp_... oder gho_..."
                style={{ flex: 1 }}
              />
              <button className="gh-auth-token-toggle" onClick={() => setShowToken(v => !v)}>
                {showToken ? '🙈' : '👁'}
              </button>
            </div>
            <div className="modal-hint">
              PAT mit <code>repo</code>-Scope. Wird verschlüsselt im macOS Keychain (vault) gespeichert.
            </div>
            <button
              className="modal-btn primary"
              style={{ marginTop: 10 }}
              disabled={!!saving || !tokenInput.trim() || !usernameInput.trim()}
              onClick={saveManual}
            >
              {saving ? 'Speichern...' : 'Speichern + Weiter'}
            </button>
          </div>

          {error && <div className="gh-auth-err">⚠ {error}</div>}
        </div>
      </div>
    </div>
  );
}
