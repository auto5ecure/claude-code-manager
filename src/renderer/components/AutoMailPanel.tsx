import { useState, useEffect } from 'react';
import { Mail, Plus, Trash2, CheckCircle, XCircle, Loader, Edit2 } from 'lucide-react';
import type { MailAccount, MailConnectionResult } from '../../shared/types';

declare global {
  interface Window {
    electronAPI: import('../../main/preload').ElectronAPI;
  }
}

const EMPTY_ACCOUNT: Omit<MailAccount, 'id'> = {
  name: '',
  host: '',
  port: 993,
  user: '',
  password: '',
  ssl: true,
  folder: 'INBOX',
};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

interface AccountModalProps {
  account: MailAccount | null; // null = new
  onSave: (account: MailAccount) => void;
  onClose: () => void;
}

function AccountModal({ account, onSave, onClose }: AccountModalProps) {
  const [form, setForm] = useState<Omit<MailAccount, 'id'>>(
    account ? { ...account } : { ...EMPTY_ACCOUNT }
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MailConnectionResult | null>(null);

  function handleChange<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    const result = await window.electronAPI.testMailConnection({
      id: account?.id ?? generateId(),
      ...form,
    });
    setTestResult(result);
    setTesting(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.host.trim() || !form.user.trim()) return;
    onSave({
      id: account?.id ?? generateId(),
      ...form,
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content automail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{account ? 'Konto bearbeiten' : 'Konto hinzufügen'}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form className="automail-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="z.B. Arbeit IMAP"
              required
            />
          </div>
          <div className="form-row">
            <div className="form-group flex-1">
              <label>Host</label>
              <input
                type="text"
                value={form.host}
                onChange={e => handleChange('host', e.target.value)}
                placeholder="imap.example.com"
                required
              />
            </div>
            <div className="form-group form-group-port">
              <label>Port</label>
              <input
                type="number"
                value={form.port}
                onChange={e => handleChange('port', parseInt(e.target.value) || 993)}
                min={1}
                max={65535}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Benutzer (E-Mail)</label>
            <input
              type="text"
              value={form.user}
              onChange={e => handleChange('user', e.target.value)}
              placeholder="user@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label>Passwort</label>
            <input
              type="password"
              value={form.password}
              onChange={e => handleChange('password', e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="form-row form-row-split">
            <div className="form-group flex-1">
              <label>Ordner</label>
              <input
                type="text"
                value={form.folder}
                onChange={e => handleChange('folder', e.target.value)}
                placeholder="INBOX"
              />
            </div>
            <div className="form-group form-group-ssl">
              <label>SSL/TLS</label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={e => {
                    handleChange('ssl', e.target.checked);
                    handleChange('port', e.target.checked ? 993 : 143);
                  }}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success
                ? <><CheckCircle size={14} /> Verbindung OK{testResult.greeting ? ` – ${testResult.greeting}` : ''}</>
                : <><XCircle size={14} /> {testResult.error}</>
              }
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
              {testing ? <><Loader size={14} className="spin" /> Teste...</> : 'Verbindung testen'}
            </button>
            <div style={{ flex: 1 }} />
            <button type="button" className="btn-secondary" onClick={onClose}>Abbrechen</button>
            <button type="submit" className="btn-primary">Speichern</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AutoMailPanel() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editAccount, setEditAccount] = useState<MailAccount | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, MailConnectionResult>>({});

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    const list = await window.electronAPI.getMailAccounts();
    setAccounts(list);
    setLoading(false);
  }

  async function handleSave(account: MailAccount) {
    await window.electronAPI.saveMailAccount(account);
    setShowModal(false);
    setEditAccount(null);
    await loadAccounts();
  }

  async function handleRemove(id: string) {
    await window.electronAPI.removeMailAccount(id);
    await loadAccounts();
  }

  async function handleTest(account: MailAccount) {
    setTestingId(account.id);
    const result = await window.electronAPI.testMailConnection(account);
    setTestResults(prev => ({ ...prev, [account.id]: result }));
    setTestingId(null);
  }

  function handleOpenAdd() {
    setEditAccount(null);
    setShowModal(true);
  }

  function handleEdit(account: MailAccount) {
    setEditAccount(account);
    setShowModal(true);
  }

  return (
    <div className="panel-view automail-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Mail size={18} />
          <span>AutoMail</span>
        </div>
        <button className="btn-primary btn-sm" onClick={handleOpenAdd}>
          <Plus size={14} /> Konto hinzufügen
        </button>
      </div>

      <div className="panel-body">
        {loading ? (
          <div className="automail-empty">
            <Loader size={24} className="spin" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="automail-empty">
            <Mail size={40} style={{ opacity: 0.3 }} />
            <p>Noch keine Mail-Konten verknüpft.</p>
            <button className="btn-primary" onClick={handleOpenAdd}>
              <Plus size={14} /> Erstes Konto hinzufügen
            </button>
          </div>
        ) : (
          <div className="automail-list">
            {accounts.map(acc => {
              const result = testResults[acc.id];
              const isTesting = testingId === acc.id;
              return (
                <div key={acc.id} className="automail-account">
                  <div className="account-icon">
                    <Mail size={20} />
                  </div>
                  <div className="account-info">
                    <div className="account-name">{acc.name}</div>
                    <div className="account-details">
                      {acc.user} · {acc.host}:{acc.port} · {acc.ssl ? 'SSL' : 'PLAIN'} · {acc.folder}
                    </div>
                    {result && (
                      <div className={`account-status ${result.success ? 'ok' : 'fail'}`}>
                        {result.success
                          ? <><CheckCircle size={12} /> OK</>
                          : <><XCircle size={12} /> {result.error}</>
                        }
                      </div>
                    )}
                  </div>
                  <div className="account-actions">
                    <button
                      className="icon-btn"
                      onClick={() => handleTest(acc)}
                      disabled={isTesting}
                      title="Verbindung testen"
                    >
                      {isTesting ? <Loader size={15} className="spin" /> : <CheckCircle size={15} />}
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => handleEdit(acc)}
                      title="Bearbeiten"
                    >
                      <Edit2 size={15} />
                    </button>
                    <button
                      className="icon-btn icon-btn-danger"
                      onClick={() => handleRemove(acc.id)}
                      title="Entfernen"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showModal && (
        <AccountModal
          account={editAccount}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditAccount(null); }}
        />
      )}
    </div>
  );
}
