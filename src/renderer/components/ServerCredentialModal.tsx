import { useState } from 'react';
import { Key, Lock, Terminal, Loader, CheckCircle, XCircle, FolderOpen } from 'lucide-react';
import type { ServerCredential } from '../../shared/types';

interface Project {
  id: string;
  name: string;
}

interface ServerCredentialModalProps {
  server?: ServerCredential | null;  // null = create new
  projects: Project[];
  onSave: (server: ServerCredential) => void;
  onClose: () => void;
}

function emptyServer(): Partial<ServerCredential> {
  return {
    name: '',
    host: '',
    port: 22,
    user: 'root',
    authType: 'key',
    sshKeyPath: '',
    hasPassphrase: false,
    hasPassword: false,
    hasApiToken: false,
    projectIds: [],
    notes: '',
  };
}

export default function ServerCredentialModal({ server, projects, onSave, onClose }: ServerCredentialModalProps) {
  const [form, setForm] = useState<Partial<ServerCredential>>(server ? { ...server } : emptyServer());
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateField<K extends keyof ServerCredential>(key: K, value: ServerCredential[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function toggleProject(id: string) {
    setForm(prev => {
      const ids = prev.projectIds || [];
      return { ...prev, projectIds: ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id] };
    });
  }

  async function handleBrowseKey() {
    const result = await window.electronAPI?.showOpenDialog({
      title: 'SSH Key auswählen',
      properties: ['openFile'],
      filters: [{ name: 'SSH Keys', extensions: ['pem', 'rsa', 'ed25519', 'key', '*'] }],
    });
    if (result?.filePaths?.[0]) updateField('sshKeyPath', result.filePaths[0]);
  }

  async function handleTest() {
    if (!form.id) {
      setTestResult({ success: false, message: 'Erst speichern, dann testen' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const result = await window.electronAPI?.testServerConnection(form.id!);
    if (result?.success) {
      setTestResult({ success: true, message: result.output || 'Verbindung erfolgreich' });
    } else {
      setTestResult({ success: false, message: result?.error || 'Verbindung fehlgeschlagen' });
    }
    setTesting(false);
  }

  async function handleSave() {
    if (!form.name?.trim()) { setError('Name ist erforderlich'); return; }
    if (!form.host?.trim()) { setError('Host ist erforderlich'); return; }
    if (!form.user?.trim()) { setError('User ist erforderlich'); return; }
    setError(null);
    setSaving(true);
    try {
      const secrets: { sshPassphrase?: string; password?: string; apiToken?: string } = {};
      if (sshPassphrase) secrets.sshPassphrase = sshPassphrase;
      if (password) secrets.password = password;
      if (apiToken) secrets.apiToken = apiToken;
      const saved = await window.electronAPI?.saveServer(form, secrets);
      if (saved) onSave(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const authType = form.authType || 'key';

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box server-cred-modal">
        <div className="modal-header">
          <Terminal size={16} />
          <span>{server ? 'Server bearbeiten' : 'Server hinzufügen'}</span>
        </div>

        <div className="modal-body">
          {/* Basic fields */}
          <div className="scm-row">
            <label>Name</label>
            <input
              className="scm-input"
              placeholder="z.B. Prod Web Server"
              value={form.name || ''}
              onChange={e => updateField('name', e.target.value)}
            />
          </div>

          <div className="scm-row-split">
            <div className="scm-field">
              <label>Host / IP</label>
              <input
                className="scm-input"
                placeholder="192.168.1.100"
                value={form.host || ''}
                onChange={e => updateField('host', e.target.value)}
              />
            </div>
            <div className="scm-field scm-field-port">
              <label>Port</label>
              <input
                className="scm-input"
                type="number"
                placeholder="22"
                value={form.port ?? 22}
                onChange={e => updateField('port', parseInt(e.target.value) || 22)}
              />
            </div>
          </div>

          <div className="scm-row">
            <label>SSH User</label>
            <input
              className="scm-input"
              placeholder="root"
              value={form.user || ''}
              onChange={e => updateField('user', e.target.value)}
            />
          </div>

          {/* Auth type */}
          <div className="scm-row">
            <label>Authentifizierung</label>
            <div className="scm-radio-group">
              {(['key', 'password', 'both'] as const).map(t => (
                <label key={t} className="scm-radio">
                  <input type="radio" name="authType" value={t} checked={authType === t} onChange={() => updateField('authType', t)} />
                  {t === 'key' ? 'SSH Key' : t === 'password' ? 'Passwort' : 'Beide'}
                </label>
              ))}
            </div>
          </div>

          {/* SSH Key fields */}
          {(authType === 'key' || authType === 'both') && (
            <>
              <div className="scm-row">
                <label><Key size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />SSH Key Pfad</label>
                <div className="scm-input-with-btn">
                  <input
                    className="scm-input"
                    placeholder="~/.ssh/id_rsa"
                    value={form.sshKeyPath || ''}
                    onChange={e => updateField('sshKeyPath', e.target.value)}
                  />
                  <button className="scm-browse-btn" onClick={handleBrowseKey} title="Durchsuchen">
                    <FolderOpen size={13} />
                  </button>
                </div>
              </div>

              <div className="scm-row">
                <label><Lock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  Passphrase {form.hasPassphrase && <span className="scm-vault-hint">(im Vault)</span>}
                </label>
                <input
                  className="scm-input"
                  type="password"
                  placeholder={form.hasPassphrase ? '(unverändert lassen)' : 'optional'}
                  value={sshPassphrase}
                  onChange={e => setSshPassphrase(e.target.value)}
                />
              </div>
            </>
          )}

          {/* Password field */}
          {(authType === 'password' || authType === 'both') && (
            <div className="scm-row">
              <label><Lock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                SSH Passwort {form.hasPassword && <span className="scm-vault-hint">(im Vault)</span>}
              </label>
              <input
                className="scm-input"
                type="password"
                placeholder={form.hasPassword ? '(unverändert lassen)' : 'Passwort eingeben'}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
          )}

          {/* API Token */}
          <div className="scm-row">
            <label>API Token {form.hasApiToken && <span className="scm-vault-hint">(im Vault)</span>}</label>
            <input
              className="scm-input"
              type="password"
              placeholder={form.hasApiToken ? '(unverändert lassen)' : 'optional'}
              value={apiToken}
              onChange={e => setApiToken(e.target.value)}
            />
          </div>

          {/* Project assignment */}
          {projects.length > 0 && (
            <div className="scm-row">
              <label>Projekte (leer = global)</label>
              <div className="scm-project-chips">
                {projects.map(p => (
                  <label key={p.id} className={`scm-chip ${(form.projectIds || []).includes(p.id) ? 'active' : ''}`}>
                    <input
                      type="checkbox"
                      checked={(form.projectIds || []).includes(p.id)}
                      onChange={() => toggleProject(p.id)}
                      style={{ display: 'none' }}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="scm-row">
            <label>Notiz</label>
            <input
              className="scm-input"
              placeholder="optional"
              value={form.notes || ''}
              onChange={e => updateField('notes', e.target.value)}
            />
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`scm-test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? <CheckCircle size={13} /> : <XCircle size={13} />}
              <span>{testResult.message}</span>
            </div>
          )}

          {error && <div className="scm-error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary btn-sm" onClick={handleTest} disabled={testing || !form.id}>
            {testing ? <Loader size={12} className="spin" /> : null}
            Verbindung testen
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary btn-sm" onClick={onClose}>Abbrechen</button>
          <button className="btn-accent btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader size={12} className="spin" /> : null}
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
