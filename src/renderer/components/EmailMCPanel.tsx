import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mail, Plus, Trash2, CheckCircle, XCircle, Loader, Edit2,
  Search, Settings, Zap, RefreshCw, FileText, Tag, Reply,
  List, X, ChevronLeft,
} from 'lucide-react';
import type { MailAccount, MailConnectionResult, MailMessage } from '../../shared/types';

declare global {
  interface Window { electronAPI: import('../../main/preload').ElectronAPI; }
}

const OLLAMA_URL_KEY = 'emailmc_ollama_url';
const OLLAMA_MODEL_KEY = 'emailmc_ollama_model';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

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

// ─── Ollama settings modal ────────────────────────────────────────────────────
interface OllamaSettingsProps {
  url: string;
  model: string;
  models: string[];
  loading: boolean;
  onSave: (url: string, model: string) => void;
  onRefreshModels: (url: string) => void;
  onClose: () => void;
}

function OllamaSettingsModal({ url, model, models, loading, onSave, onRefreshModels, onClose }: OllamaSettingsProps) {
  const [editUrl, setEditUrl] = useState(url);
  const [editModel, setEditModel] = useState(model);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content emailmc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Ollama Einstellungen</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="emailmc-form" style={{ gap: 14 }}>
          <div className="form-group">
            <label>Ollama URL</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={editUrl} onChange={e => setEditUrl(e.target.value)} placeholder="http://localhost:11434" style={{ flex: 1 }} />
              <button className="btn-secondary btn-sm" onClick={() => onRefreshModels(editUrl)} disabled={loading}>
                {loading ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label>Modell</label>
            {models.length > 0 ? (
              <select value={editModel} onChange={e => setEditModel(e.target.value)} className="emailmc-select">
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input type="text" value={editModel} onChange={e => setEditModel(e.target.value)} placeholder="z.B. llama3:latest" />
            )}
            {models.length === 0 && !loading && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                Kein Modell gefunden – Ollama läuft?
              </span>
            )}
          </div>
          <div className="modal-actions">
            <div style={{ flex: 1 }} />
            <button className="btn-secondary" onClick={onClose}>Abbrechen</button>
            <button className="btn-primary" onClick={() => { onSave(editUrl, editModel); onClose(); }}>
              Speichern
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Account modal ────────────────────────────────────────────────────────────
const EMPTY_ACCOUNT: Omit<MailAccount, 'id'> = {
  name: '', host: '', port: 993, user: '', password: '', ssl: true, folder: 'INBOX',
  authType: 'basic', oauth2ClientId: '', oauth2TenantId: 'common',
};

interface AccountModalProps { account: MailAccount | null; onSave: (a: MailAccount) => void; onClose: () => void; }

function AccountModal({ account, onSave, onClose }: AccountModalProps) {
  const [form, setForm] = useState<Omit<MailAccount, 'id'>>(account ? { ...account } : { ...EMPTY_ACCOUNT });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MailConnectionResult | null>(null);

  const isOAuth2 = form.authType === 'oauth2';

  function handleChange<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm(prev => ({ ...prev, [key]: value })); setTestResult(null);
  }

  function handleAuthTypeChange(val: 'basic' | 'oauth2') {
    setForm(prev => ({
      ...prev,
      authType: val,
      host: val === 'oauth2' ? 'outlook.office365.com' : prev.host,
      port: 993,
      ssl: true,
    }));
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true); setTestResult(null);
    const r = await window.electronAPI.testMailConnection({ id: account?.id ?? generateId(), ...form });
    setTestResult(r); setTesting(false);
  }

  const canSubmit = form.name && form.host && form.user && (!isOAuth2 || form.oauth2ClientId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content emailmc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{account ? 'Konto bearbeiten' : 'Konto hinzufügen'}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form className="emailmc-form" onSubmit={e => { e.preventDefault(); if (canSubmit) onSave({ id: account?.id ?? generateId(), ...form }); }}>
          {/* Auth type */}
          <div className="form-group">
            <label>Authentifizierung</label>
            <select value={form.authType || 'basic'} onChange={e => handleAuthTypeChange(e.target.value as 'basic' | 'oauth2')} className="emailmc-select">
              <option value="basic">IMAP Basic Auth (Passwort)</option>
              <option value="oauth2">Office 365 (OAuth2 / Modern Auth)</option>
            </select>
          </div>

          <div className="form-group">
            <label>Name</label>
            <input type="text" value={form.name} onChange={e => handleChange('name', e.target.value)} placeholder="z.B. Arbeit O365" required />
          </div>
          <div className="form-row">
            <div className="form-group flex-1"><label>Host</label>
              <input type="text" value={form.host} onChange={e => handleChange('host', e.target.value)} placeholder="imap.example.com" required />
            </div>
            <div className="form-group form-group-port"><label>Port</label>
              <input type="number" value={form.port} onChange={e => handleChange('port', parseInt(e.target.value) || 993)} min={1} max={65535} />
            </div>
          </div>
          <div className="form-group">
            <label>Benutzer (E-Mail)</label>
            <input type="text" value={form.user} onChange={e => handleChange('user', e.target.value)} placeholder="user@example.com" required />
          </div>

          {/* Basic auth: password */}
          {!isOAuth2 && (
            <div className="form-group">
              <label>Passwort</label>
              <input type="password" value={form.password} onChange={e => handleChange('password', e.target.value)} placeholder="••••••••" />
            </div>
          )}

          {/* OAuth2: Client ID + Tenant ID */}
          {isOAuth2 && (
            <>
              <div className="form-group">
                <label>Client ID <span className="form-hint">(Azure App Registration)</span></label>
                <input type="text" value={form.oauth2ClientId || ''} onChange={e => handleChange('oauth2ClientId', e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required />
              </div>
              <div className="form-group">
                <label>Tenant ID <span className="form-hint">(oder "common" für alle Org.)</span></label>
                <input type="text" value={form.oauth2TenantId || 'common'} onChange={e => handleChange('oauth2TenantId', e.target.value || 'common')}
                  placeholder="common" />
              </div>
              <div className="oauth2-setup-hint">
                Azure Portal → App registrations → Neue App → Redirect URI Typ: <strong>Mobile/Desktop</strong>, Wert: <code>http://localhost</code>. Berechtigung: <code>IMAP.AccessAsUser.All</code>
              </div>
            </>
          )}

          <div className="form-row form-row-split">
            <div className="form-group flex-1"><label>Ordner</label>
              <input type="text" value={form.folder} onChange={e => handleChange('folder', e.target.value)} placeholder="INBOX" />
            </div>
            {!isOAuth2 && (
              <div className="form-group form-group-ssl"><label>SSL/TLS</label>
                <label className="toggle-label">
                  <input type="checkbox" checked={form.ssl} onChange={e => { handleChange('ssl', e.target.checked); handleChange('port', e.target.checked ? 993 : 143); }} />
                  <span className="toggle-track" />
                </label>
              </div>
            )}
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? <><CheckCircle size={14} /> OK</> : <><XCircle size={14} /> {testResult.error}</>}
            </div>
          )}
          <div className="modal-actions">
            {!isOAuth2 && (
              <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
                {testing ? <><Loader size={14} className="spin" /> Teste...</> : 'Verbindung testen'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" className="btn-secondary" onClick={onClose}>Abbrechen</button>
            <button type="submit" className="btn-primary" disabled={!canSubmit}>Speichern</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Ollama analysis prompts ──────────────────────────────────────────────────
type AnalysisMode = 'summary' | 'category' | 'reply' | 'extract';

const ANALYSIS_PROMPTS: Record<AnalysisMode, { system: string; label: string; icon: React.ReactNode }> = {
  summary:  { label: 'Zusammenfassung', icon: <FileText size={13} />, system: 'Du bist ein E-Mail-Assistent. Fasse die E-Mail prägnant auf Deutsch zusammen (max 3 Sätze). Keine Floskeln.' },
  category: { label: 'Kategorie',       icon: <Tag size={13} />, system: 'Klassifiziere diese E-Mail. Antworte genau so: Kategorie: [Arbeit/Privat/Newsletter/Spam/Anfrage/Rechnung/Sonstiges]\nPriorität: [hoch/mittel/niedrig]\nGrund: [ein Satz]' },
  reply:    { label: 'Antwort-Entwurf', icon: <Reply size={13} />, system: 'Schreibe einen professionellen, prägnanten Antwort-Entwurf auf Deutsch für diese E-Mail. Beginne direkt mit der Anrede.' },
  extract:  { label: 'Extraktion',      icon: <List size={13} />, system: 'Extrahiere aus dieser E-Mail auf Deutsch als strukturierte Liste: Termine (Datum/Uhrzeit), Aufgaben/TODOs, wichtige Zahlen/Fristen. Falls nichts vorhanden: "Keine gefunden."' },
};

function buildUserMessage(msg: MailMessage, body?: string): string {
  return `Von: ${msg.from}\nBetreff: ${msg.subject}\nDatum: ${msg.date}\n\n${body ? body.slice(0, 5000) : '(kein Volltext geladen)'}`;
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
export default function EmailMCPanel() {
  // Accounts
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<MailAccount | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editAccount, setEditAccount] = useState<MailAccount | null>(null);
  const [oauth2Status, setOauth2Status] = useState<Record<string, boolean>>({});
  const [oauth2Authorizing, setOauth2Authorizing] = useState<Record<string, boolean>>({});

  // Messages
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [filteredMessages, setFilteredMessages] = useState<MailMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);

  // Body
  const [messageBody, setMessageBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState(() => localStorage.getItem(OLLAMA_URL_KEY) ?? DEFAULT_OLLAMA_URL);
  const [ollamaModel, setOllamaModel] = useState(() => localStorage.getItem(OLLAMA_MODEL_KEY) ?? '');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null); // null=unchecked
  const [showOllamaSettings, setShowOllamaSettings] = useState(false);

  // Analysis
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('summary');
  const [analysisOutput, setAnalysisOutput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const analysisRef = useRef<HTMLDivElement>(null);
  const ollamaUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => { loadAccounts(); checkOllama(ollamaUrl); }, []);

  // Check OAuth2 status when account list changes
  useEffect(() => {
    const oauth2Accounts = accounts.filter(a => a.authType === 'oauth2');
    if (oauth2Accounts.length === 0) return;
    oauth2Accounts.forEach(async (a) => {
      const status = await window.electronAPI.getOAuth2Status(a.id);
      setOauth2Status(prev => ({ ...prev, [a.id]: status.authorized }));
    });
  }, [accounts]);

  // Scroll analysis output to bottom
  useEffect(() => {
    if (analysisRef.current) analysisRef.current.scrollTop = analysisRef.current.scrollHeight;
  }, [analysisOutput]);

  async function loadAccounts() {
    setLoadingAccounts(true);
    const list = await window.electronAPI.getMailAccounts();
    setAccounts(list);
    setLoadingAccounts(false);
  }

  async function authorizeOAuth2(acc: MailAccount) {
    setOauth2Authorizing(prev => ({ ...prev, [acc.id]: true }));
    const result = await window.electronAPI.startOAuth2(acc);
    setOauth2Authorizing(prev => ({ ...prev, [acc.id]: false }));
    setOauth2Status(prev => ({ ...prev, [acc.id]: result.success }));
  }

  async function checkOllama(url: string) {
    const result = await window.electronAPI.ollamaListModels(url);
    setOllamaReady(result.success);
    if (result.success && result.models) {
      setAvailableModels(result.models);
      if (!ollamaModel && result.models.length > 0) setOllamaModel(result.models[0]);
    }
  }

  async function refreshModels(url: string) {
    setLoadingModels(true);
    const result = await window.electronAPI.ollamaListModels(url);
    if (result.success && result.models) {
      setAvailableModels(result.models);
      setOllamaReady(true);
      if (!ollamaModel && result.models.length > 0) setOllamaModel(result.models[0]);
    } else {
      setOllamaReady(false);
    }
    setLoadingModels(false);
  }

  function saveOllamaSettings(url: string, model: string) {
    setOllamaUrl(url); setOllamaModel(model);
    localStorage.setItem(OLLAMA_URL_KEY, url);
    localStorage.setItem(OLLAMA_MODEL_KEY, model);
    checkOllama(url);
  }

  async function selectAccount(acc: MailAccount) {
    setSelectedAccount(acc);
    setSelectedMessage(null);
    setMessageBody(null);
    setMessages([]);
    setFilteredMessages([]);
    setSearchQuery('');
    setMessagesError(null);
    setLoadingMessages(true);
    const result = await window.electronAPI.fetchMailMessages(acc, 40);
    if (result.success && result.messages) {
      setMessages(result.messages);
      setFilteredMessages(result.messages);
    } else {
      setMessagesError(result.error ?? 'Fehler beim Laden');
    }
    setLoadingMessages(false);
  }

  async function selectMessage(msg: MailMessage) {
    setSelectedMessage(msg);
    setMessageBody(null);
    setAnalysisOutput('');
  }

  async function loadBody() {
    if (!selectedAccount || !selectedMessage) return;
    setLoadingBody(true);
    const result = await window.electronAPI.fetchMailBody(selectedAccount, selectedMessage.uid);
    setMessageBody(result.success ? (result.text ?? '') : `Fehler: ${result.error}`);
    setLoadingBody(false);
  }

  const runAnalysis = useCallback(async () => {
    if (!selectedMessage || !ollamaModel) return;
    if (analyzing) return;

    // Cleanup previous listener
    if (ollamaUnsubRef.current) { ollamaUnsubRef.current(); ollamaUnsubRef.current = null; }

    setAnalyzing(true);
    setAnalysisOutput('');

    const prompt = ANALYSIS_PROMPTS[analysisMode];
    const userMessage = buildUserMessage(selectedMessage, messageBody ?? undefined);

    let output = '';
    const unsub = window.electronAPI.onOllamaChunk((data) => {
      if (data.text) { output += data.text; setAnalysisOutput(output); }
      if (data.done) { setAnalyzing(false); if (ollamaUnsubRef.current) { ollamaUnsubRef.current(); ollamaUnsubRef.current = null; } }
    });
    ollamaUnsubRef.current = unsub;

    await window.electronAPI.ollamaAnalyze(ollamaUrl, ollamaModel, prompt.system, userMessage);
  }, [selectedMessage, ollamaModel, ollamaUrl, analysisMode, messageBody, analyzing]);

  // Semantic search via Ollama
  async function runSearch() {
    if (!searchQuery.trim() || messages.length === 0 || !ollamaModel) return;
    if (searchQuery.trim().length < 3) { setFilteredMessages(messages); return; }
    setSearching(true);

    const emailList = messages.map(m => `[${m.uid}] Von: ${m.from} | Betreff: ${m.subject}`).join('\n');
    const systemPrompt = 'Du bekommst eine Liste von E-Mails (jede mit einer ID in eckigen Klammern) und eine Suchanfrage. Gib NUR die IDs der passenden E-Mails zurück, kommasepariert. Keine Erklärung.';
    const userMessage = `Suchanfrage: "${searchQuery}"\n\nE-Mails:\n${emailList}`;

    let collected = '';
    const unsub = window.electronAPI.onOllamaChunk((data) => {
      if (data.text) collected += data.text;
      if (data.done) {
        unsub();
        const ids = collected.match(/\d+/g)?.map(Number) ?? [];
        if (ids.length > 0) {
          setFilteredMessages(messages.filter(m => ids.includes(m.uid)));
        } else {
          setFilteredMessages(messages); // no filter if no match
        }
        setSearching(false);
      }
    });

    await window.electronAPI.ollamaAnalyze(ollamaUrl, ollamaModel, systemPrompt, userMessage);
  }

  function clearSearch() {
    setSearchQuery('');
    setFilteredMessages(messages);
  }

  async function handleSaveAccount(account: MailAccount) {
    await window.electronAPI.saveMailAccount(account);
    setShowAccountModal(false); setEditAccount(null);
    await loadAccounts();
  }

  async function handleRemoveAccount(id: string) {
    await window.electronAPI.removeMailAccount(id);
    await window.electronAPI.revokeOAuth2(id);
    setOauth2Status(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (selectedAccount?.id === id) { setSelectedAccount(null); setMessages([]); setFilteredMessages([]); }
    await loadAccounts();
  }

  return (
    <div className="panel-view emailmc-panel">
      {/* Header */}
      <div className="panel-header">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Mail size={18} />
          <span>EmailMC</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Ollama status dot */}
          <span title={`Ollama: ${ollamaReady === null ? 'wird geprüft' : ollamaReady ? `bereit (${ollamaModel || 'kein Modell'})` : 'nicht erreichbar'}`}
            className={`ollama-dot ${ollamaReady === true ? 'ok' : ollamaReady === false ? 'fail' : 'checking'}`} />
          <button className="icon-btn" onClick={() => setShowOllamaSettings(true)} title="Ollama Einstellungen">
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Body: 3-pane */}
      <div className="emailmc-body">
        {/* ── LEFT: Account list ── */}
        <div className="emailmc-accounts-pane">
          <div className="emailmc-pane-header">
            <span>Konten</span>
            <button className="icon-btn" onClick={() => { setEditAccount(null); setShowAccountModal(true); }} title="Konto hinzufügen">
              <Plus size={14} />
            </button>
          </div>
          {loadingAccounts ? (
            <div className="emailmc-center"><Loader size={16} className="spin" /></div>
          ) : accounts.length === 0 ? (
            <div className="emailmc-hint">Kein Konto.<br />Klicke + zum Hinzufügen.</div>
          ) : accounts.map(acc => {
            const isOAuth2 = acc.authType === 'oauth2';
            const isAuthorized = !isOAuth2 || oauth2Status[acc.id];
            const isAuthorizingThis = oauth2Authorizing[acc.id];
            return (
              <div key={acc.id}
                className={`emailmc-account-item ${selectedAccount?.id === acc.id ? 'active' : ''} ${isOAuth2 && !isAuthorized ? 'needs-auth' : ''}`}
                onClick={() => isAuthorized ? selectAccount(acc) : undefined}
              >
                <Mail size={13} />
                <div className="emailmc-account-label">
                  <span className="emailmc-account-name">
                    {acc.name}
                    {isOAuth2 && (
                      <span className={`oauth2-badge ${isAuthorized ? 'ok' : 'pending'}`} title={isAuthorized ? 'OAuth2 autorisiert' : 'Nicht angemeldet'}>
                        {isAuthorized ? '🔐' : '⚠'}
                      </span>
                    )}
                  </span>
                  <span className="emailmc-account-sub">{acc.user}</span>
                </div>
                <div className="emailmc-account-btns">
                  {isOAuth2 && !isAuthorized && (
                    <button className="btn-oauth2-sm" title="Mit Microsoft anmelden"
                      disabled={isAuthorizingThis}
                      onClick={e => { e.stopPropagation(); authorizeOAuth2(acc); }}>
                      {isAuthorizingThis ? <Loader size={11} className="spin" /> : 'Anmelden'}
                    </button>
                  )}
                  {isOAuth2 && isAuthorized && (
                    <button className="icon-btn" title="OAuth2 widerrufen"
                      onClick={e => { e.stopPropagation(); window.electronAPI.revokeOAuth2(acc.id).then(() => setOauth2Status(prev => ({ ...prev, [acc.id]: false }))); }}>
                      <XCircle size={12} />
                    </button>
                  )}
                  <button className="icon-btn" onClick={e => { e.stopPropagation(); setEditAccount(acc); setShowAccountModal(true); }} title="Bearbeiten"><Edit2 size={12} /></button>
                  <button className="icon-btn icon-btn-danger" onClick={e => { e.stopPropagation(); handleRemoveAccount(acc.id); }} title="Entfernen"><Trash2 size={12} /></button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── CENTER: Message list ── */}
        <div className="emailmc-messages-pane">
          {/* Search bar */}
          {selectedAccount && (
            <div className="emailmc-searchbar">
              <Search size={13} />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runSearch()}
                placeholder="Ollama-Suche (Enter)"
              />
              {searchQuery && <button className="icon-btn" onClick={clearSearch}><X size={12} /></button>}
              <button className="icon-btn" onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                {searching ? <Loader size={12} className="spin" /> : <Zap size={12} />}
              </button>
            </div>
          )}

          {!selectedAccount ? (
            <div className="emailmc-center" style={{ flex: 1 }}>
              <Mail size={32} style={{ opacity: 0.2 }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Konto auswählen</span>
            </div>
          ) : loadingMessages ? (
            <div className="emailmc-center" style={{ flex: 1 }}>
              <Loader size={20} className="spin" />
            </div>
          ) : messagesError ? (
            <div className="emailmc-center" style={{ flex: 1, color: 'var(--error, #ef4444)', fontSize: 13 }}>
              <XCircle size={18} /><span>{messagesError}</span>
              <button className="btn-secondary btn-sm" onClick={() => selectAccount(selectedAccount)}>
                <RefreshCw size={12} /> Erneut
              </button>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="emailmc-center" style={{ flex: 1 }}>
              <CheckCircle size={18} style={{ opacity: 0.3 }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                {searchQuery ? 'Keine Treffer' : 'Keine Nachrichten'}
              </span>
            </div>
          ) : (
            <div className="emailmc-msg-list">
              {filteredMessages.map(msg => (
                <div key={msg.uid}
                  className={`emailmc-msg-item ${msg.seen ? 'seen' : 'unseen'} ${selectedMessage?.uid === msg.uid ? 'selected' : ''}`}
                  onClick={() => selectMessage(msg)}
                >
                  <div className="emailmc-msg-dot" />
                  <div className="emailmc-msg-body">
                    <div className="emailmc-msg-row">
                      <span className="emailmc-msg-from">{msg.from}</span>
                      <span className="emailmc-msg-date">{formatDate(msg.date)}</span>
                    </div>
                    <div className="emailmc-msg-subject">{msg.subject}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT: Analysis pane ── */}
        {selectedMessage && (
          <div className="emailmc-analysis-pane">
            {/* Message info */}
            <div className="emailmc-analysis-header">
              <button className="icon-btn" onClick={() => setSelectedMessage(null)} title="Schließen">
                <ChevronLeft size={15} />
              </button>
              <div className="emailmc-analysis-meta">
                <div className="emailmc-analysis-from">{selectedMessage.from}</div>
                <div className="emailmc-analysis-subject">{selectedMessage.subject}</div>
                <div className="emailmc-analysis-date">{selectedMessage.date}</div>
              </div>
            </div>

            {/* Load body */}
            <div className="emailmc-body-bar">
              {messageBody === null ? (
                <button className="btn-secondary btn-sm" onClick={loadBody} disabled={loadingBody}>
                  {loadingBody ? <><Loader size={12} className="spin" /> Lade...</> : <><FileText size={12} /> Volltext laden</>}
                </button>
              ) : (
                <span className="emailmc-body-ok"><CheckCircle size={12} /> Volltext geladen ({messageBody.length} Zeichen)</span>
              )}
            </div>

            {/* LLM Mode selector */}
            <div className="emailmc-analysis-tabs">
              {(Object.entries(ANALYSIS_PROMPTS) as [AnalysisMode, typeof ANALYSIS_PROMPTS[AnalysisMode]][]).map(([mode, cfg]) => (
                <button
                  key={mode}
                  className={`emailmc-analysis-tab ${analysisMode === mode ? 'active' : ''}`}
                  onClick={() => { setAnalysisMode(mode); setAnalysisOutput(''); }}
                >
                  {cfg.icon} {cfg.label}
                </button>
              ))}
            </div>

            {/* Run button */}
            <div className="emailmc-run-bar">
              {!ollamaModel ? (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Ollama-Modell konfigurieren ↗</span>
              ) : (
                <button
                  className="btn-primary btn-sm"
                  onClick={runAnalysis}
                  disabled={analyzing}
                >
                  {analyzing
                    ? <><Loader size={13} className="spin" /> Analysiert...</>
                    : <><Zap size={13} /> {ANALYSIS_PROMPTS[analysisMode].label}</>
                  }
                </button>
              )}
              <span className="emailmc-model-badge">{ollamaModel || '—'}</span>
            </div>

            {/* Output */}
            <div className="emailmc-output" ref={analysisRef}>
              {analysisOutput ? (
                <pre className="emailmc-output-text">{analysisOutput}{analyzing && <span className="emailmc-cursor">▋</span>}</pre>
              ) : (
                <div className="emailmc-output-placeholder">
                  {ollamaModel
                    ? `${ANALYSIS_PROMPTS[analysisMode].label} starten ↑`
                    : 'Kein Ollama-Modell gewählt'
                  }
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showOllamaSettings && (
        <OllamaSettingsModal
          url={ollamaUrl} model={ollamaModel}
          models={availableModels} loading={loadingModels}
          onSave={saveOllamaSettings}
          onRefreshModels={refreshModels}
          onClose={() => setShowOllamaSettings(false)}
        />
      )}
      {showAccountModal && (
        <AccountModal
          account={editAccount}
          onSave={handleSaveAccount}
          onClose={() => { setShowAccountModal(false); setEditAccount(null); }}
        />
      )}
    </div>
  );
}
