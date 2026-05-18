import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import {
  Mail, Plus, Trash2, CheckCircle, XCircle, Loader, Edit2,
  Search, Settings, Zap, RefreshCw, FileText, Tag, Reply,
  List, X, ChevronLeft, FolderOpen, Brain, Power,
  ChevronRight, ChevronDown, Folder,
} from 'lucide-react';
import type { MailAccount, MailConnectionResult, MailMessage } from '../../shared/types';
import { startLoading, stopLoading, updateLoadingLabel } from '../utils/loading';

declare global {
  interface Window { electronAPI: import('../../main/preload').ElectronAPI; }
}

const OLLAMA_URL_KEY = 'emailmc_ollama_url';
const OLLAMA_MODEL_KEY = 'emailmc_ollama_model';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const SMART_CACHE_PREFIX = 'emailmc_smart_';
const AI_PROVIDER_KEY = 'emailmc_ai_provider';
const CLAUDE_MODEL_KEY = 'emailmc_claude_model';
const DEFAULT_CLAUDE_MODEL = 'haiku';

type AIProvider = 'ollama' | 'claude';

type SmartCategory = 'URGENT' | 'ACTION' | 'RECHNUNG' | 'EINKAUF' | 'FYI' | 'NOISE';
type SmartView = 'ALL' | SmartCategory;

const SMART_TABS: { key: SmartView; label: string; color: string }[] = [
  { key: 'ALL',      label: 'Alle',     color: '' },
  { key: 'URGENT',   label: 'Dringend', color: '#ef4444' },
  { key: 'ACTION',   label: 'Aufgabe',  color: '#f97316' },
  { key: 'RECHNUNG', label: 'Rechnung', color: '#10b981' },
  { key: 'EINKAUF',  label: 'Einkauf',  color: '#a855f7' },
  { key: 'FYI',      label: 'Info',     color: '#3b82f6' },
  { key: 'NOISE',    label: 'Rauschen', color: '#6b7280' },
];

const COMPANY_DOMAIN_MAP: Record<string, string> = {
  'amazon.de': 'Amazon', 'amazon.com': 'Amazon', 'amazon.co.uk': 'Amazon',
  'otto.de': 'Otto', 'zalando.de': 'Zalando', 'zalando.com': 'Zalando',
  'ebay.de': 'eBay', 'ebay.com': 'eBay',
  'mediamarkt.de': 'MediaMarkt', 'saturn.de': 'Saturn',
  'ikea.com': 'IKEA', 'ikea.de': 'IKEA',
  'apple.com': 'Apple', 'shopify.com': 'Shopify',
  'dhl.de': 'DHL', 'dhl.com': 'DHL',
  'dpd.de': 'DPD', 'dpd.com': 'DPD',
  'hermesworld.com': 'Hermes', 'myhermes.de': 'Hermes', 'hermes-germany.de': 'Hermes',
  'gls-pakete.de': 'GLS', 'gls-group.com': 'GLS',
  'ups.com': 'UPS', 'fedex.com': 'FedEx',
  'paypal.de': 'PayPal', 'paypal.com': 'PayPal',
  'klarna.de': 'Klarna', 'klarna.com': 'Klarna',
  'thalia.de': 'Thalia', 'hugendubel.de': 'Hugendubel',
  'conrad.de': 'Conrad', 'reichelt.de': 'Reichelt',
  'notebooksbilliger.de': 'notebooksbilliger', 'cyberport.de': 'Cyberport',
  'alternate.de': 'Alternate', 'mindfactory.de': 'Mindfactory',
  'bauhaus.info': 'Bauhaus', 'obi.de': 'OBI', 'hornbach.de': 'Hornbach',
};

function extractCompanyFromAddress(from: string): string {
  // "Name <email@domain.com>" → "email@domain.com"; fallback: from itself
  const match = from.match(/<([^>]+)>/);
  const email = (match ? match[1] : from).trim().toLowerCase();
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0) return 'Sonstige';
  let domain = email.slice(atIdx + 1).replace(/[>,;\s].*$/, '');
  // Strip common subdomains (mail.amazon.de → amazon.de; noreply.shop.amazon.de → amazon.de)
  const parts = domain.split('.').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (COMPANY_DOMAIN_MAP[candidate]) return COMPANY_DOMAIN_MAP[candidate];
  }
  // Take last 2 parts as root domain (e.g. amazon.de), capitalize first
  if (parts.length >= 2) {
    const root = parts[parts.length - 2];
    return root.charAt(0).toUpperCase() + root.slice(1);
  }
  return 'Sonstige';
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

interface FolderNode {
  name: string;
  full: string;
  children: FolderNode[];
}

function detectFolderDelimiter(folders: string[]): string {
  if (folders.some(f => f.includes('/'))) return '/';
  if (folders.some(f => f.includes('.') && !f.match(/^[^.]+\.[a-z]{2,4}$/i))) return '.';
  return '/';
}

function buildFolderTree(folders: string[]): { roots: FolderNode[]; delimiter: string } {
  const delimiter = detectFolderDelimiter(folders);
  const nodes = new Map<string, FolderNode>();

  for (const full of folders) {
    const parts = full.split(delimiter);
    let path = '';
    for (let i = 0; i < parts.length; i++) {
      path = i === 0 ? parts[0] : `${path}${delimiter}${parts[i]}`;
      if (!nodes.has(path)) {
        nodes.set(path, { name: parts[i], full: path, children: [] });
      }
    }
  }

  const roots: FolderNode[] = [];
  for (const [path, node] of nodes) {
    const lastDelim = path.lastIndexOf(delimiter);
    if (lastDelim === -1) {
      roots.push(node);
    } else {
      const parent = nodes.get(path.substring(0, lastDelim));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const sortRec = (arr: FolderNode[]) => {
    arr.sort((a, b) => {
      if (a.name.toUpperCase() === 'INBOX') return -1;
      if (b.name.toUpperCase() === 'INBOX') return 1;
      return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
    });
    arr.forEach(n => sortRec(n.children));
  };
  sortRec(roots);

  return { roots, delimiter };
}

function ancestorPaths(full: string, delimiter: string): string[] {
  const parts = full.split(delimiter);
  const out: string[] = [];
  let path = '';
  for (let i = 0; i < parts.length - 1; i++) {
    path = i === 0 ? parts[0] : `${path}${delimiter}${parts[i]}`;
    out.push(path);
  }
  return out;
}

interface FolderTreeItemProps {
  node: FolderNode;
  depth: number;
  selectedFolder: string;
  expandedSet: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function FolderTreeItem({ node, depth, selectedFolder, expandedSet, onToggle, onSelect }: FolderTreeItemProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedSet.has(node.full);
  const isActive = selectedFolder === node.full;

  return (
    <Fragment>
      <div
        className={`emailmc-folder-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(node.full)}
      >
        <button
          className="emailmc-folder-chevron"
          onClick={e => { e.stopPropagation(); if (hasChildren) onToggle(node.full); }}
          tabIndex={-1}
          aria-label={hasChildren ? (isExpanded ? 'Einklappen' : 'Ausklappen') : undefined}
        >
          {hasChildren
            ? (isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
            : <span className="emailmc-folder-chevron-spacer" />
          }
        </button>
        <Folder size={11} className="emailmc-folder-icon" />
        <span className="emailmc-folder-name" title={node.full}>{node.name}</span>
      </div>
      {hasChildren && isExpanded && node.children.map(child => (
        <FolderTreeItem
          key={child.full}
          node={child}
          depth={depth + 1}
          selectedFolder={selectedFolder}
          expandedSet={expandedSet}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </Fragment>
  );
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

// ─── AI Settings Modal (Ollama + Claude) ──────────────────────────────────────
interface AISettingsProps {
  url: string;
  model: string;
  models: string[];
  loading: boolean;
  provider: AIProvider;
  claudeModel: string;
  onSave: (provider: AIProvider, ollamaUrl: string, ollamaModel: string, claudeModel: string) => void;
  onRefreshModels: (url: string) => void;
  onClose: () => void;
}

function OllamaSettingsModal({ url, model, models, loading, provider, claudeModel, onSave, onRefreshModels, onClose }: AISettingsProps) {
  const [editProvider, setEditProvider] = useState<AIProvider>(provider);
  const [editUrl, setEditUrl] = useState(url);
  const [editModel, setEditModel] = useState(model);
  const [editClaudeModel, setEditClaudeModel] = useState(claudeModel);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content emailmc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>AI Einstellungen</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="emailmc-form" style={{ gap: 14 }}>
          <div className="form-group">
            <label>Provider</label>
            <div className="emailmc-provider-toggle">
              <button
                className={`emailmc-provider-btn ${editProvider === 'claude' ? 'active' : ''}`}
                onClick={() => setEditProvider('claude')}
                type="button"
              >
                <span className="emailmc-provider-title">Claude (Inkognito)</span>
                <span className="emailmc-provider-sub">Cloud · keine Session-Persistenz · beste Qualität</span>
              </button>
              <button
                className={`emailmc-provider-btn ${editProvider === 'ollama' ? 'active' : ''}`}
                onClick={() => setEditProvider('ollama')}
                type="button"
              >
                <span className="emailmc-provider-title">Ollama</span>
                <span className="emailmc-provider-sub">Lokal · offline · privat</span>
              </button>
            </div>
          </div>

          {editProvider === 'claude' && (
            <div className="form-group">
              <label>Claude Modell</label>
              <select value={editClaudeModel} onChange={e => setEditClaudeModel(e.target.value)} className="emailmc-select">
                <option value="haiku">Haiku 4.5 (schnell + günstig, empfohlen)</option>
                <option value="sonnet">Sonnet 4.6 (beste Qualität)</option>
                <option value="opus">Opus 4.7 (höchste Genauigkeit, langsamer)</option>
              </select>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                Nutzt die installierte Claude CLI im --no-session-persistence Modus.
              </span>
            </div>
          )}

          {editProvider === 'ollama' && (
            <>
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
                <label>Ollama Modell</label>
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
            </>
          )}

          <div className="modal-actions">
            <div style={{ flex: 1 }} />
            <button className="btn-secondary" onClick={onClose}>Abbrechen</button>
            <button className="btn-primary" onClick={() => { onSave(editProvider, editUrl, editModel, editClaudeModel); onClose(); }}>
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

const VAULT_SENTINEL = '__vault__';

function AccountModal({ account, onSave, onClose }: AccountModalProps) {
  const hasVaultPassword = account?.password === VAULT_SENTINEL;
  const [form, setForm] = useState<Omit<MailAccount, 'id'>>(
    account ? { ...account, password: hasVaultPassword ? '' : account.password } : { ...EMPTY_ACCOUNT }
  );
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
    const password = form.password || (hasVaultPassword ? VAULT_SENTINEL : '');
    const r = await window.electronAPI.testMailConnection({ id: account?.id ?? generateId(), ...form, password });
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
        <form className="emailmc-form" onSubmit={e => {
          e.preventDefault();
          if (!canSubmit) return;
          const password = form.password || (hasVaultPassword ? VAULT_SENTINEL : '');
          onSave({ id: account?.id ?? generateId(), ...form, password });
        }}>
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
              <input type="password" value={form.password} onChange={e => handleChange('password', e.target.value)}
                placeholder={hasVaultPassword ? '● gespeichert – leer lassen zum Behalten' : '••••••••'} />
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
                <strong>Azure Setup (Single-Tenant):</strong><br />
                1. App registrations → Neue App → Typ: <em>Single Tenant</em><br />
                2. Authentication → Redirect URI: <strong>Mobile/Desktop</strong> → <code>http://localhost</code><br />
                3. API Permissions → <strong>APIs my organization uses</strong> → "Office 365 Exchange Online" → <code>IMAP.AccessAsUser.All</code><br />
                4. Tenant ID: Azure AD → Overview → "Directory (tenant) ID" (NICHT "common"!)
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
export default function EmailMCPanel({ onUnreadCountChange, isActive }: { onUnreadCountChange?: (count: number) => void; isActive?: boolean }) {
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

  // Folders
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Body
  const [messageBody, setMessageBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState(() => localStorage.getItem(OLLAMA_URL_KEY) ?? DEFAULT_OLLAMA_URL);
  const [ollamaModel, setOllamaModel] = useState(() => localStorage.getItem(OLLAMA_MODEL_KEY) ?? '');
  const [aiProvider, setAiProvider] = useState<AIProvider>(() => (localStorage.getItem(AI_PROVIDER_KEY) as AIProvider) || 'claude');
  const [claudeModel, setClaudeModel] = useState(() => localStorage.getItem(CLAUDE_MODEL_KEY) ?? DEFAULT_CLAUDE_MODEL);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null); // null=unchecked
  const [showOllamaSettings, setShowOllamaSettings] = useState(false);
  const [killingOllama, setKillingOllama] = useState(false);

  // Smart folders
  const [smartView, setSmartView] = useState<SmartView>('ALL');
  const [mailCategories, setMailCategories] = useState<Record<string, SmartCategory>>({});
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState<{ done: number; total: number } | null>(null);
  const [classifyingUid, setClassifyingUid] = useState<number | null>(null);
  const [einkaufExpanded, setEinkaufExpanded] = useState(true);
  const [companyFilter, setCompanyFilter] = useState<string | null>(null);

  // Analysis
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('summary');
  const [analysisOutput, setAnalysisOutput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const analysisRef = useRef<HTMLDivElement>(null);
  const ollamaUnsubRef = useRef<(() => void) | null>(null);
  const searchQueryRef = useRef(searchQuery);
  useEffect(() => { searchQueryRef.current = searchQuery; }, [searchQuery]);

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

  // Report unread count to parent whenever messages change
  useEffect(() => {
    onUnreadCountChange?.(messages.filter(m => !m.seen).length);
  }, [messages]);

  // Auto-Sort: klassifiziere fehlende Mails sobald sie geladen sind
  useEffect(() => {
    if (!selectedAccount || messages.length === 0) return;
    if (classifying || classifyingUid !== null) return;
    const folder = selectedFolder || selectedAccount.folder;
    const missing = messages.filter(m => !mailCategories[String(m.uid)]);
    if (missing.length === 0) return;
    autoClassifyMissingMails(messages, mailCategories, selectedAccount, folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Auto-refresh every 2 minutes — only when EmailMC panel is active
  useEffect(() => {
    if (!selectedAccount || !isActive) return;
    const interval = setInterval(async () => {
      if (classifying || classifyingUid !== null) return; // skip if classifying
      const folder = selectedFolder || selectedAccount.folder;
      try {
        const accWithFolder = { ...selectedAccount, folder };
        const result = await window.electronAPI.fetchMailMessages(accWithFolder, 40);
        if (result.success && result.messages) {
          setMessages(result.messages);
          if (!searchQueryRef.current.trim()) setFilteredMessages(result.messages);
        }
      } catch { /* silent fail */ }
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedAccount, selectedFolder, isActive, classifying, classifyingUid]);

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

  async function handleKillOllama() {
    setKillingOllama(true);
    await window.electronAPI.killOllama();
    // kurz warten, dann Status neu prüfen
    setTimeout(() => {
      setOllamaReady(null);
      checkOllama(ollamaUrl).finally(() => setKillingOllama(false));
    }, 800);
  }

  function saveAISettings(provider: AIProvider, url: string, model: string, cModel: string) {
    setAiProvider(provider); setOllamaUrl(url); setOllamaModel(model); setClaudeModel(cModel);
    localStorage.setItem(AI_PROVIDER_KEY, provider);
    localStorage.setItem(OLLAMA_URL_KEY, url);
    localStorage.setItem(OLLAMA_MODEL_KEY, model);
    localStorage.setItem(CLAUDE_MODEL_KEY, cModel);
    if (provider === 'ollama') checkOllama(url);
  }

  function smartCacheKey(acc: MailAccount, folder: string) {
    return `${SMART_CACHE_PREFIX}${acc.id}_${folder}`;
  }

  function loadSmartCache(acc: MailAccount, folder: string) {
    try {
      const raw = localStorage.getItem(smartCacheKey(acc, folder));
      if (raw) setMailCategories(JSON.parse(raw));
      else setMailCategories({});
    } catch { setMailCategories({}); }
  }

  function saveSmartCache(acc: MailAccount, folder: string, cats: Record<string, SmartCategory>) {
    try { localStorage.setItem(smartCacheKey(acc, folder), JSON.stringify(cats)); } catch { /* ignore */ }
  }

  // Wrappt Ollama-Operationen: startet Ollama bei Bedarf, killt es nach Abschluss
  async function withOllama<T>(fn: () => Promise<T>): Promise<T> {
    const ensured = await window.electronAPI.ollamaEnsureRunning(ollamaUrl);
    if (!ensured.success) {
      setOllamaReady(false);
      throw new Error(ensured.error || 'Ollama konnte nicht gestartet werden');
    }
    setOllamaReady(true);
    try {
      return await fn();
    } finally {
      try { await window.electronAPI.killOllama(); } catch { /* best-effort */ }
      setOllamaReady(false);
    }
  }

  async function runSmartSort() {
    if (!selectedAccount || classifying || messages.length === 0) return;
    if (aiProvider === 'ollama' && !ollamaModel) return;
    setClassifying(true);
    setMailCategories({}); // clear old (possibly wrong) cache before re-sorting
    setSmartView('ALL');
    setClassifyProgress({ done: 0, total: messages.length });
    const acc = selectedAccount;
    const folderKey = selectedFolder || acc.folder;

    const progressUnsub = window.electronAPI.onClassifyMailProgress((data) => {
      setClassifyProgress({ done: data.done, total: data.total });
      updateLoadingLabel(`Smart Sort (${data.done}/${data.total})`);
      setMailCategories(prev => {
        const next = { ...prev, [String(data.uid)]: data.category as SmartCategory };
        saveSmartCache(acc, folderKey, next);
        return next;
      });
    });

    const emails = messages.map(m => ({ uid: m.uid, from: m.from, subject: m.subject }));

    try {
      if (aiProvider === 'claude') {
        startLoading(`Smart Sort via Claude (${claudeModel})...`);
        await window.electronAPI.claudeClassifyMailBatch(emails, claudeModel);
      } else {
        startLoading('Ollama wird gestartet...');
        await withOllama(async () => {
          updateLoadingLabel(`Smart Sort (0/${messages.length})`);
          await window.electronAPI.classifyMail(ollamaUrl, ollamaModel, emails);
        });
      }
    } catch (err) {
      console.error('[runSmartSort]', err);
    } finally {
      progressUnsub();
      setClassifying(false);
      setClassifyProgress(null);
      stopLoading();
    }
  }

  async function classifySingleMail(msg: MailMessage) {
    if (classifyingUid !== null || classifying) return;
    if (aiProvider === 'ollama' && !ollamaModel) return;
    setClassifyingUid(msg.uid);
    const email = { uid: msg.uid, from: msg.from, subject: msg.subject };
    try {
      let cat: SmartCategory = 'FYI';
      if (aiProvider === 'claude') {
        const results = await window.electronAPI.claudeClassifyMailBatch([email], claudeModel);
        if (results && results.length > 0) cat = results[0].category as SmartCategory;
      } else {
        await withOllama(async () => {
          const results = await window.electronAPI.classifyMail(ollamaUrl, ollamaModel, [email]);
          if (results && results.length > 0) cat = results[0].category as SmartCategory;
        });
      }
      setMailCategories(prev => {
        const next = { ...prev, [String(msg.uid)]: cat };
        saveSmartCache(selectedAccount!, selectedFolder || selectedAccount!.folder, next);
        return next;
      });
    } catch (err) {
      console.error('[classifySingle]', err);
    } finally {
      setClassifyingUid(null);
    }
  }

  // Auto-Sort: klassifiziert im Hintergrund alle Mails ohne aktuelle Kategorie.
  // Wird automatisch nach jedem Mail-Load aufgerufen (selectAccount, selectFolder, Auto-Refresh).
  async function autoClassifyMissingMails(msgs: MailMessage[], cats: Record<string, SmartCategory>, acc: MailAccount, folder: string) {
    if (classifying) return;
    if (aiProvider === 'ollama' && !ollamaModel) return;
    const missing = msgs.filter(m => !cats[String(m.uid)]);
    if (missing.length === 0) return;

    setClassifying(true);
    setClassifyProgress({ done: 0, total: missing.length });

    const progressUnsub = window.electronAPI.onClassifyMailProgress((data) => {
      setClassifyProgress({ done: data.done, total: data.total });
      updateLoadingLabel(`Auto-Sort (${data.done}/${data.total})`);
      setMailCategories(prev => {
        const next = { ...prev, [String(data.uid)]: data.category as SmartCategory };
        saveSmartCache(acc, folder, next);
        return next;
      });
    });

    const emails = missing.map(m => ({ uid: m.uid, from: m.from, subject: m.subject }));
    startLoading(`Auto-Sort (0/${missing.length})`);

    try {
      if (aiProvider === 'claude') {
        await window.electronAPI.claudeClassifyMailBatch(emails, claudeModel);
      } else {
        await withOllama(async () => {
          await window.electronAPI.classifyMail(ollamaUrl, ollamaModel, emails);
        });
      }
    } catch (err) {
      console.error('[autoClassifyMissing]', err);
    } finally {
      progressUnsub();
      setClassifying(false);
      setClassifyProgress(null);
      stopLoading();
    }
  }

  async function loadMessages(acc: MailAccount, folder: string) {
    setSelectedMessage(null);
    setMessageBody(null);
    setMessages([]);
    setFilteredMessages([]);
    setSearchQuery('');
    setMessagesError(null);
    setSmartView('ALL');
    setClassifying(false);
    setClassifyProgress(null);
    loadSmartCache(acc, folder);
    setLoadingMessages(true);
    startLoading('E-Mails werden geladen...');
    const accWithFolder = { ...acc, folder };
    const result = await window.electronAPI.fetchMailMessages(accWithFolder, 40);
    if (result.success && result.messages) {
      setMessages(result.messages);
      setFilteredMessages(result.messages);
    } else {
      setMessagesError(result.error ?? 'Fehler beim Laden');
    }
    setLoadingMessages(false);
    stopLoading();
  }

  async function selectAccount(acc: MailAccount) {
    setSelectedAccount(acc);
    setAvailableFolders([]);
    setExpandedFolders(new Set());
    const defaultFolder = acc.folder || 'INBOX';
    setSelectedFolder(defaultFolder);
    await loadMessages(acc, defaultFolder);
    const fr = await window.electronAPI.listMailFolders(acc);
    if (fr.success && fr.folders) {
      setAvailableFolders(fr.folders);
      const { delimiter } = buildFolderTree(fr.folders);
      setExpandedFolders(new Set(ancestorPaths(defaultFolder, delimiter)));
    }
  }

  async function selectFolder(folderName: string) {
    if (!selectedAccount || folderName === selectedFolder) return;
    setSelectedFolder(folderName);
    await loadMessages(selectedAccount, folderName);
  }

  function toggleFolderExpanded(path: string) {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
    if (!selectedMessage) return;
    if (analyzing) return;
    if (aiProvider === 'ollama' && !ollamaModel) return;

    // Cleanup previous listener
    if (ollamaUnsubRef.current) { ollamaUnsubRef.current(); ollamaUnsubRef.current = null; }

    setAnalyzing(true);
    const prompt = ANALYSIS_PROMPTS[analysisMode];
    const userMessage = buildUserMessage(selectedMessage, messageBody ?? undefined);

    if (aiProvider === 'claude') {
      setAnalysisOutput('');
      let output = '';
      const unsub = window.electronAPI.onClaudeChunk((data) => {
        if (data.text) { output += data.text; setAnalysisOutput(output); }
        if (data.done) { setAnalyzing(false); if (ollamaUnsubRef.current) { ollamaUnsubRef.current(); ollamaUnsubRef.current = null; } }
      });
      ollamaUnsubRef.current = unsub;
      try {
        await window.electronAPI.claudeAnalyzeMail(prompt.system, userMessage, claudeModel);
      } catch (err) {
        setAnalysisOutput(`Fehler: ${(err as Error).message}`);
        setAnalyzing(false);
      }
      return;
    }

    setAnalysisOutput('Ollama wird gestartet...');
    try {
      await withOllama(async () => {
        setAnalysisOutput('');
        let output = '';
        const unsub = window.electronAPI.onOllamaChunk((data) => {
          if (data.text) { output += data.text; setAnalysisOutput(output); }
          if (data.done) { setAnalyzing(false); if (ollamaUnsubRef.current) { ollamaUnsubRef.current(); ollamaUnsubRef.current = null; } }
        });
        ollamaUnsubRef.current = unsub;
        await window.electronAPI.ollamaAnalyze(ollamaUrl, ollamaModel, prompt.system, userMessage);
      });
    } catch (err) {
      setAnalysisOutput(`Fehler: ${(err as Error).message}`);
      setAnalyzing(false);
    }
  }, [selectedMessage, ollamaModel, ollamaUrl, analysisMode, messageBody, analyzing, aiProvider, claudeModel]);

  // Semantic search via Ollama or Claude
  async function runSearch() {
    if (!searchQuery.trim() || messages.length === 0) return;
    if (aiProvider === 'ollama' && !ollamaModel) return;
    if (searchQuery.trim().length < 3) { setFilteredMessages(messages); return; }
    setSearching(true);

    const emailList = messages.map(m => `[${m.uid}] Von: ${m.from} | Betreff: ${m.subject}`).join('\n');
    const systemPrompt = 'Du bekommst eine Liste von E-Mails (jede mit einer ID in eckigen Klammern) und eine Suchanfrage. Gib NUR die IDs der passenden E-Mails zurück, kommasepariert. Keine Erklärung.';
    const userMessage = `Suchanfrage: "${searchQuery}"\n\nE-Mails:\n${emailList}`;

    const applyResult = (collected: string) => {
      const ids = collected.match(/\d+/g)?.map(Number) ?? [];
      if (ids.length > 0) setFilteredMessages(messages.filter(m => ids.includes(m.uid)));
      else setFilteredMessages(messages);
    };

    let unsubChunk: (() => void) | null = null;
    try {
      if (aiProvider === 'claude') {
        let collected = '';
        unsubChunk = window.electronAPI.onClaudeChunk((data) => {
          if (data.text) collected += data.text;
          if (data.done) applyResult(collected);
        });
        await window.electronAPI.claudeAnalyzeMail(systemPrompt, userMessage, claudeModel);
      } else {
        await withOllama(async () => {
          let collected = '';
          unsubChunk = window.electronAPI.onOllamaChunk((data) => {
            if (data.text) collected += data.text;
            if (data.done) applyResult(collected);
          });
          await window.electronAPI.ollamaAnalyze(ollamaUrl, ollamaModel, systemPrompt, userMessage);
        });
      }
    } catch (err) {
      console.error('[runSearch]', err);
    } finally {
      if (unsubChunk) (unsubChunk as () => void)();
      setSearching(false);
    }
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

  const classifiedCount = messages.filter(m => mailCategories[String(m.uid)] !== undefined).length;
  const smartCounts: Record<SmartCategory, number> = {
    URGENT:   messages.filter(m => mailCategories[String(m.uid)] === 'URGENT').length,
    ACTION:   messages.filter(m => mailCategories[String(m.uid)] === 'ACTION').length,
    RECHNUNG: messages.filter(m => mailCategories[String(m.uid)] === 'RECHNUNG').length,
    EINKAUF:  messages.filter(m => mailCategories[String(m.uid)] === 'EINKAUF').length,
    FYI:      messages.filter(m => mailCategories[String(m.uid)] === 'FYI').length,
    NOISE:    messages.filter(m => mailCategories[String(m.uid)] === 'NOISE').length,
  };

  // Firmen-Gruppierung der EINKAUF-Mails
  const einkaufCompanies: { name: string; count: number }[] = (() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (mailCategories[String(m.uid)] !== 'EINKAUF') continue;
      const company = extractCompanyFromAddress(m.from);
      counts.set(company, (counts.get(company) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  })();

  const displayedMessages = smartView === 'ALL'
    ? filteredMessages
    : filteredMessages.filter(m => {
        if (mailCategories[String(m.uid)] !== smartView) return false;
        if (smartView === 'EINKAUF' && companyFilter) {
          return extractCompanyFromAddress(m.from) === companyFilter;
        }
        return true;
      });

  return (
    <div className="panel-view emailmc-panel">
      {/* Header */}
      <div className="panel-header">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Mail size={18} />
          <span>EmailMC</span>
          {(loadingMessages || classifying || analyzing || searching) && (
            <Loader size={13} className="spin" style={{ color: 'var(--text-secondary)', marginLeft: 4 }} />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Ollama status dot */}
          {aiProvider === 'claude' ? (
            <span title={`Claude Inkognito (${claudeModel}) – on-demand via Claude CLI`}
              className="ollama-dot ok" style={{ background: '#a855f7' }} />
          ) : (
            <>
              <span title={`Ollama: ${ollamaReady === null ? 'wird geprüft' : ollamaReady ? `bereit (${ollamaModel || 'kein Modell'})` : 'nicht erreichbar'}`}
                className={`ollama-dot ${ollamaReady === true ? 'ok' : ollamaReady === false ? 'fail' : 'checking'}`} />
              {ollamaReady === true && (
                <button
                  className="icon-btn"
                  onClick={handleKillOllama}
                  disabled={killingOllama}
                  title="Ollama beenden"
                  style={{ color: killingOllama ? 'var(--text-secondary)' : '#ef4444' }}
                >
                  {killingOllama ? <Loader size={14} className="spin" /> : <Power size={14} />}
                </button>
              )}
            </>
          )}
          <button className="icon-btn" onClick={() => setShowOllamaSettings(true)} title="AI Einstellungen">
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
            const isSelected = selectedAccount?.id === acc.id;
            return (
              <Fragment key={acc.id}>
                <div
                  className={`emailmc-account-item ${isSelected ? 'active' : ''} ${isOAuth2 && !isAuthorized ? 'needs-auth' : ''}`}
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

                {/* IMAP folder tree – under selected account */}
                {isSelected && availableFolders.length > 0 && (
                  <div className="emailmc-folder-tree">
                    {buildFolderTree(availableFolders).roots.map(node => (
                      <FolderTreeItem
                        key={node.full}
                        node={node}
                        depth={0}
                        selectedFolder={selectedFolder}
                        expandedSet={expandedFolders}
                        onToggle={toggleFolderExpanded}
                        onSelect={selectFolder}
                      />
                    ))}
                  </div>
                )}

                {/* Smart folder tree – under selected account */}
                {isSelected && (
                  <div className="emailmc-smart-tree">
                    <div className="emailmc-smart-tree-header">
                      <Brain size={11} />
                      <span>Smart Ordner</span>
                      <button
                        className="icon-btn emailmc-smart-sort-btn"
                        onClick={e => { e.stopPropagation(); runSmartSort(); }}
                        disabled={classifying || messages.length === 0 || (aiProvider === 'ollama' && !ollamaModel)}
                        title={`Mails klassifizieren (${aiProvider === 'claude' ? `Claude ${claudeModel}` : 'Ollama'})`}
                      >
                        {classifying
                          ? <><Loader size={10} className="spin" /> {classifyProgress?.done}/{classifyProgress?.total}</>
                          : <span className="smart-sort-label">Sortieren</span>
                        }
                      </button>
                    </div>
                    {classifiedCount > 0 && SMART_TABS.map(tab => {
                      const count = tab.key === 'ALL' ? messages.length : smartCounts[tab.key as SmartCategory];
                      const isEinkauf = tab.key === 'EINKAUF';
                      const showSubList = isEinkauf && einkaufExpanded && einkaufCompanies.length > 0;
                      return (
                        <Fragment key={tab.key}>
                          <button
                            className={`emailmc-smart-folder ${smartView === tab.key && !companyFilter ? 'active' : ''}`}
                            onClick={() => {
                              setSmartView(tab.key);
                              setCompanyFilter(null);
                              if (isEinkauf) setEinkaufExpanded(v => !v || smartView !== 'EINKAUF');
                            }}
                          >
                            {isEinkauf && einkaufCompanies.length > 0 && (
                              <span className="smart-chevron">{einkaufExpanded ? '▾' : '▸'}</span>
                            )}
                            {tab.key !== 'ALL' && <span className="smart-dot" style={{ background: tab.color }} />}
                            {tab.key === 'ALL' && <span className="smart-dot" style={{ background: 'var(--text-secondary)', opacity: 0.4 }} />}
                            <span className="smart-folder-label">{tab.label}</span>
                            <span className="smart-count">{count}</span>
                          </button>
                          {showSubList && einkaufCompanies.map(c => (
                            <button
                              key={`einkauf-${c.name}`}
                              className={`emailmc-smart-folder emailmc-smart-subfolder ${smartView === 'EINKAUF' && companyFilter === c.name ? 'active' : ''}`}
                              onClick={() => { setSmartView('EINKAUF'); setCompanyFilter(c.name); }}
                              title={c.name}
                            >
                              <span className="smart-subfolder-tree">└</span>
                              <span className="smart-folder-label">{c.name}</span>
                              <span className="smart-count">{c.count}</span>
                            </button>
                          ))}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </Fragment>
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
                placeholder={aiProvider === 'claude' ? 'Claude-Suche (Enter)' : 'Ollama-Suche (Enter)'}
              />
              {searchQuery && <button className="icon-btn" onClick={clearSearch}><X size={12} /></button>}
              <button className="icon-btn" onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                {searching ? <Loader size={12} className="spin" /> : <Zap size={12} />}
              </button>
            </div>
          )}

          {/* Current folder breadcrumb */}
          {selectedAccount && selectedFolder && (
            <div className="emailmc-folder-bar">
              <FolderOpen size={12} />
              <span className="emailmc-folder-breadcrumb" title={selectedFolder}>{selectedFolder}</span>
            </div>
          )}

          {/* Classification progress bar */}
          {classifying && classifyProgress && (
            <div className="emailmc-classify-bar">
              <div
                className="emailmc-classify-fill"
                style={{ width: `${Math.round((classifyProgress.done / classifyProgress.total) * 100)}%` }}
              />
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
              <button className="btn-secondary btn-sm" onClick={() => loadMessages(selectedAccount, selectedFolder || selectedAccount.folder)}>
                <RefreshCw size={12} /> Erneut
              </button>
            </div>
          ) : displayedMessages.length === 0 ? (
            <div className="emailmc-center" style={{ flex: 1 }}>
              <CheckCircle size={18} style={{ opacity: 0.3 }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                {searchQuery ? 'Keine Treffer' : smartView !== 'ALL' ? 'Keine Mails in dieser Kategorie' : 'Keine Nachrichten'}
              </span>
            </div>
          ) : (
            <div className="emailmc-msg-list">
              {displayedMessages.map(msg => {
                const cat = mailCategories[String(msg.uid)];
                const catColor = cat === 'URGENT' ? '#ef4444' : cat === 'ACTION' ? '#f97316' : cat === 'RECHNUNG' ? '#10b981' : cat === 'EINKAUF' ? '#a855f7' : cat === 'FYI' ? '#3b82f6' : cat === 'NOISE' ? '#6b7280' : undefined;
                return (
                  <div key={msg.uid}
                    className={`emailmc-msg-item ${msg.seen ? 'seen' : 'unseen'} ${selectedMessage?.uid === msg.uid ? 'selected' : ''}`}
                    onClick={() => selectMessage(msg)}
                  >
                    <div className="emailmc-msg-dot" />
                    <div className="emailmc-msg-body">
                      <div className="emailmc-msg-row">
                        <span className="emailmc-msg-from">{msg.from}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {cat && <span className="emailmc-cat-badge" style={{ background: catColor }}>{cat}</span>}
                          <span className="emailmc-msg-date">{formatDate(msg.date)}</span>
                          {(aiProvider === 'claude' || ollamaModel) && (
                            <button
                              className="emailmc-classify-btn"
                              title={`Klassifizieren via ${aiProvider === 'claude' ? `Claude ${claudeModel}` : 'Ollama'}`}
                              onClick={e => { e.stopPropagation(); classifySingleMail(msg); }}
                              disabled={classifyingUid === msg.uid || classifying}
                            >
                              {classifyingUid === msg.uid
                                ? <Loader size={10} className="spin" />
                                : <Brain size={10} />}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="emailmc-msg-subject">{msg.subject}</div>
                    </div>
                  </div>
                );
              })}
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
              {aiProvider === 'ollama' && !ollamaModel ? (
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
              <span className="emailmc-model-badge">
                {aiProvider === 'claude' ? `Claude ${claudeModel}` : (ollamaModel || '—')}
              </span>
            </div>

            {/* Output */}
            <div className="emailmc-output" ref={analysisRef}>
              {analysisOutput ? (
                <pre className="emailmc-output-text">{analysisOutput}{analyzing && <span className="emailmc-cursor">▋</span>}</pre>
              ) : (
                <div className="emailmc-output-placeholder">
                  {(aiProvider === 'claude' || ollamaModel)
                    ? `${ANALYSIS_PROMPTS[analysisMode].label} starten ↑`
                    : 'Kein Modell gewählt'
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
          provider={aiProvider} claudeModel={claudeModel}
          onSave={saveAISettings}
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
