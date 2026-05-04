import { useState, useEffect, useRef, useCallback } from 'react';
import type { PasswordEntry } from '../../shared/types';

const CATEGORY_SUGGESTIONS = ['Web', 'Server', 'Privat', 'Arbeit', 'Finanzen', 'Sonstiges'];

type SystemCredentialType =
  | 'mail-password' | 'mail-oauth2'
  | 'server-password' | 'server-passphrase' | 'server-apitoken'
  | 'github-token';

interface SystemCredential {
  vaultKey: string;
  type: SystemCredentialType;
  category: 'Mail' | 'Server' | 'GitHub';
  label: string;
  username: string;
  detail?: string;
  accountId: string;
}

const TYPE_LABEL: Record<SystemCredentialType, string> = {
  'mail-password': 'IMAP-Passwort',
  'mail-oauth2': 'OAuth2-Token',
  'server-password': 'SSH-Passwort',
  'server-passphrase': 'SSH-Key-Passphrase',
  'server-apitoken': 'API-Token',
  'github-token': 'GitHub-PAT',
};

function formatOAuth2(secretJson: string | null): string {
  if (!secretJson) return '';
  try {
    const obj = JSON.parse(secretJson);
    const exp = obj.expiresAt ? new Date(obj.expiresAt).toLocaleString('de-DE') : '–';
    const access = (obj.accessToken || '').slice(0, 24);
    return `accessToken: ${access}…\nrefreshToken: (vorhanden)\nexpiresAt: ${exp}`;
  } catch {
    return secretJson;
  }
}

function generatePassword(length: number, upper: boolean, lower: boolean, digits: boolean, special: boolean): string {
  let charset = '';
  if (upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (lower) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (digits) charset += '0123456789';
  if (special) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

interface FormState {
  id?: string;
  name: string;
  url: string;
  username: string;
  category: string;
  notes: string;
  password: string;
}

const emptyForm: FormState = {
  name: '',
  url: '',
  username: '',
  category: '',
  notes: '',
  password: '',
};

export default function PasswordManagerPanel() {
  const [tab, setTab] = useState<'own' | 'system'>('own');
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  // System-Credentials (read-only Übersicht aller Vault-Credentials)
  const [sysCreds, setSysCreds] = useState<SystemCredential[]>([]);
  const [sysSearch, setSysSearch] = useState('');
  const [sysCategoryFilter, setSysCategoryFilter] = useState<'' | 'Mail' | 'Server' | 'GitHub'>('');
  const [sysRevealedKey, setSysRevealedKey] = useState<string | null>(null);
  const [sysRevealedSecret, setSysRevealedSecret] = useState<string | null>(null);
  const [sysCopiedKey, setSysCopiedKey] = useState<string | null>(null);
  const sysRevealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sysClipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Generator state
  const [genLength, setGenLength] = useState(20);
  const [genUpper, setGenUpper] = useState(true);
  const [genLower, setGenLower] = useState(true);
  const [genDigits, setGenDigits] = useState(true);
  const [genSpecial, setGenSpecial] = useState(true);
  const [showGenerator, setShowGenerator] = useState(false);

  // Reveal / copy state
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [revealTimer, setRevealTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showFormPassword, setShowFormPassword] = useState(false);

  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load entries
  useEffect(() => {
    window.electronAPI?.getPasswords().then(setEntries).catch(console.error);
  }, []);

  // Load system credentials when tab is opened
  const loadSystemCredentials = useCallback(() => {
    window.electronAPI?.getSystemCredentials?.().then(setSysCreds).catch(console.error);
  }, []);

  useEffect(() => {
    if (tab === 'system') loadSystemCredentials();
  }, [tab, loadSystemCredentials]);

  const sysFiltered = sysCreds.filter(c => {
    const q = sysSearch.toLowerCase();
    const matchSearch = !q ||
      c.label.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q) ||
      (c.detail || '').toLowerCase().includes(q);
    const matchCat = !sysCategoryFilter || c.category === sysCategoryFilter;
    return matchSearch && matchCat;
  });

  const sysGrouped = sysFiltered.reduce<Record<string, SystemCredential[]>>((acc, c) => {
    (acc[c.category] ||= []).push(c);
    return acc;
  }, {});

  const handleSysReveal = useCallback(async (cred: SystemCredential) => {
    if (sysRevealTimer.current) clearTimeout(sysRevealTimer.current);
    if (sysRevealedKey === cred.vaultKey) {
      setSysRevealedKey(null);
      setSysRevealedSecret(null);
      return;
    }
    const res = await window.electronAPI?.getVaultSecret?.(cred.vaultKey);
    let display = res?.secret ?? null;
    if (display && cred.type === 'mail-oauth2') display = formatOAuth2(display);
    setSysRevealedKey(cred.vaultKey);
    setSysRevealedSecret(display);
    sysRevealTimer.current = setTimeout(() => {
      setSysRevealedKey(null);
      setSysRevealedSecret(null);
    }, 10000);
  }, [sysRevealedKey]);

  const handleSysCopy = useCallback(async (cred: SystemCredential) => {
    const res = await window.electronAPI?.getVaultSecret?.(cred.vaultKey);
    if (!res?.secret) return;
    let toCopy = res.secret;
    if (cred.type === 'mail-oauth2') {
      try { toCopy = JSON.parse(res.secret).accessToken || res.secret; } catch { /* keep raw */ }
    }
    await navigator.clipboard.writeText(toCopy);
    setSysCopiedKey(cred.vaultKey);
    if (sysClipboardTimer.current) clearTimeout(sysClipboardTimer.current);
    sysClipboardTimer.current = setTimeout(async () => {
      await navigator.clipboard.writeText('');
      setSysCopiedKey(null);
    }, 30000);
    setTimeout(() => setSysCopiedKey(null), 2000);
  }, []);

  const categories = Array.from(new Set(entries.map(e => e.category).filter(Boolean)));

  const filtered = entries.filter(e => {
    const q = search.toLowerCase();
    const matchSearch = !q || e.name.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q);
    const matchCat = !categoryFilter || e.category === categoryFilter;
    return matchSearch && matchCat;
  });

  const selected = entries.find(e => e.id === selectedId) ?? null;

  function handleSelect(entry: PasswordEntry) {
    setSelectedId(entry.id);
    setMode('view');
    setRevealedId(null);
    setRevealedSecret(null);
    setShowFormPassword(false);
    setShowGenerator(false);
  }

  function handleNewEntry() {
    setSelectedId(null);
    setMode('new');
    setForm(emptyForm);
    setShowFormPassword(false);
    setShowGenerator(false);
  }

  function handleEdit() {
    if (!selected) return;
    setForm({
      id: selected.id,
      name: selected.name,
      url: selected.url || '',
      username: selected.username,
      category: selected.category,
      notes: selected.notes || '',
      password: '',
    });
    setMode('edit');
    setShowFormPassword(false);
    setShowGenerator(false);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.username.trim()) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI?.savePassword(
        { id: form.id, name: form.name, url: form.url || undefined, username: form.username, category: form.category || 'Sonstiges', notes: form.notes || undefined },
        form.password
      );
      if (saved) {
        setEntries(prev => {
          const i = prev.findIndex(e => e.id === saved.id);
          if (i >= 0) { const next = [...prev]; next[i] = saved; return next; }
          return [saved, ...prev];
        });
        setSelectedId(saved.id);
        setMode('view');
      }
    } catch (err) {
      console.error('Failed to save password:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selected || !confirm(`"${selected.name}" wirklich löschen?`)) return;
    await window.electronAPI?.removePassword(selected.id);
    setEntries(prev => prev.filter(e => e.id !== selected.id));
    setSelectedId(null);
    setMode('view');
  }

  function handleCancel() {
    if (mode === 'new') { setSelectedId(null); }
    setMode('view');
    setShowFormPassword(false);
    setShowGenerator(false);
  }

  // Reveal password for 10 seconds
  const handleReveal = useCallback(async (id: string) => {
    if (revealTimer) clearTimeout(revealTimer);
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedSecret(null);
      return;
    }
    const res = await window.electronAPI?.getPasswordSecret(id);
    setRevealedId(id);
    setRevealedSecret(res?.password ?? null);
    const t = setTimeout(() => {
      setRevealedId(null);
      setRevealedSecret(null);
    }, 10000);
    setRevealTimer(t);
  }, [revealedId, revealTimer]);

  // Copy password to clipboard, clear after 30s
  const handleCopy = useCallback(async (id: string) => {
    const res = await window.electronAPI?.getPasswordSecret(id);
    if (!res?.password) return;
    await navigator.clipboard.writeText(res.password);
    setCopiedId(id);
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      await navigator.clipboard.writeText('');
      setCopiedId(null);
    }, 30000);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
      if (revealTimer) clearTimeout(revealTimer);
      if (sysRevealTimer.current) clearTimeout(sysRevealTimer.current);
      if (sysClipboardTimer.current) clearTimeout(sysClipboardTimer.current);
    };
  }, [revealTimer]);

  function handleGenerate() {
    const pw = generatePassword(genLength, genUpper, genLower, genDigits, genSpecial);
    setForm(f => ({ ...f, password: pw }));
  }

  const isEditing = mode === 'edit' || mode === 'new';

  return (
    <div className="pwm-panel">
      <div className="pwm-tabbar">
        <button
          className={`pwm-tab-btn ${tab === 'own' ? 'active' : ''}`}
          onClick={() => setTab('own')}
        >🔑 Eigene Passwörter ({entries.length})</button>
        <button
          className={`pwm-tab-btn ${tab === 'system' ? 'active' : ''}`}
          onClick={() => setTab('system')}
        >🛡 System-Credentials ({sysCreds.length})</button>
        {tab === 'system' && (
          <button
            className="pwm-tab-refresh"
            onClick={loadSystemCredentials}
            title="Neu laden"
          >↻</button>
        )}
      </div>

      {tab === 'system' ? (
        <div className="pwm-sys-view">
          <div className="pwm-sys-toolbar">
            <input
              className="pwm-search"
              type="text"
              placeholder="Suche nach Name, Benutzer, Host..."
              value={sysSearch}
              onChange={e => setSysSearch(e.target.value)}
            />
            <select
              className="pwm-cat-filter"
              value={sysCategoryFilter}
              onChange={e => setSysCategoryFilter(e.target.value as '' | 'Mail' | 'Server' | 'GitHub')}
            >
              <option value="">Alle Kategorien</option>
              <option value="Mail">Mail</option>
              <option value="Server">Server</option>
              <option value="GitHub">GitHub</option>
            </select>
          </div>
          <div className="pwm-sys-info">
            Diese Credentials werden von Claude MC für Mail-, Server- und Git-Operationen genutzt.
            Sie sind verschlüsselt im Vault (macOS Keychain) gespeichert und read-only.
          </div>
          <div className="pwm-sys-list">
            {sysFiltered.length === 0 && (
              <div className="pwm-list-empty">Keine System-Credentials gefunden</div>
            )}
            {Object.entries(sysGrouped).map(([cat, items]) => (
              <div key={cat} className="pwm-sys-group">
                <div className="pwm-sys-group-title">{cat} ({items.length})</div>
                {items.map(cred => {
                  const isRevealed = sysRevealedKey === cred.vaultKey;
                  const isCopied = sysCopiedKey === cred.vaultKey;
                  return (
                    <div key={cred.vaultKey} className="pwm-sys-item">
                      <div className="pwm-sys-item-main">
                        <div className="pwm-sys-item-row1">
                          <span className="pwm-sys-item-label">{cred.label}</span>
                          <span className="pwm-sys-item-type">{TYPE_LABEL[cred.type]}</span>
                        </div>
                        <div className="pwm-sys-item-row2">
                          <span className="pwm-sys-item-user">{cred.username}</span>
                          {cred.detail && <span className="pwm-sys-item-detail"> · {cred.detail}</span>}
                        </div>
                        <div className="pwm-sys-item-secret">
                          <span className="pwm-sys-item-secret-value">
                            {isRevealed && sysRevealedSecret
                              ? sysRevealedSecret
                              : '••••••••••••••••'}
                          </span>
                        </div>
                      </div>
                      <div className="pwm-sys-item-actions">
                        <button
                          className={`pwm-icon-btn ${isRevealed ? 'active' : ''}`}
                          onClick={() => handleSysReveal(cred)}
                          title={isRevealed ? 'Verbergen' : '10s anzeigen'}
                        >👁</button>
                        <button
                          className={`pwm-icon-btn ${isCopied ? 'active' : ''}`}
                          onClick={() => handleSysCopy(cred)}
                          title="Kopieren (30s Clipboard-Auto-Leerung)"
                        >{isCopied ? '✓' : '📋'}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
      <div className="pwm-tab-content">
      {/* Left sidebar */}
      <div className="pwm-sidebar">
        <div className="pwm-sidebar-header">
          <input
            className="pwm-search"
            type="text"
            placeholder="Suche..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="pwm-cat-filter"
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
          >
            <option value="">Alle Kategorien</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button className="pwm-new-btn" onClick={handleNewEntry}>+ Neuer Eintrag</button>
        </div>
        <div className="pwm-list">
          {filtered.length === 0 && (
            <div className="pwm-list-empty">Keine Einträge</div>
          )}
          {filtered.map(entry => (
            <button
              key={entry.id}
              className={`pwm-list-item ${selectedId === entry.id ? 'active' : ''}`}
              onClick={() => handleSelect(entry)}
            >
              <div className="pwm-list-item-name">{entry.name}</div>
              <div className="pwm-list-item-meta">{entry.category} · {entry.username}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Right detail / form */}
      <div className="pwm-detail">
        {!isEditing && !selected && (
          <div className="pwm-empty-state">
            <div className="pwm-empty-icon">🔑</div>
            <div className="pwm-empty-text">Eintrag auswählen oder neu anlegen</div>
          </div>
        )}

        {/* View mode */}
        {!isEditing && selected && (
          <div className="pwm-view">
            <div className="pwm-view-header">
              <h2 className="pwm-view-title">{selected.name}</h2>
              <div className="pwm-view-actions">
                <button className="pwm-btn pwm-btn-secondary" onClick={handleEdit}>Bearbeiten</button>
                <button className="pwm-btn pwm-btn-danger" onClick={handleDelete}>Löschen</button>
              </div>
            </div>
            <div className="pwm-field-list">
              {selected.url && (
                <div className="pwm-field">
                  <label>URL</label>
                  <span className="pwm-field-value pwm-url">
                    <a href="#" onClick={e => { e.preventDefault(); window.electronAPI?.openExternal(selected.url!); }}>
                      {selected.url}
                    </a>
                  </span>
                </div>
              )}
              <div className="pwm-field">
                <label>Benutzername</label>
                <span className="pwm-field-value">{selected.username}</span>
              </div>
              <div className="pwm-field">
                <label>Kategorie</label>
                <span className="pwm-field-value">{selected.category}</span>
              </div>
              <div className="pwm-field">
                <label>Passwort</label>
                <div className="pwm-pw-row">
                  <span className="pwm-field-value pwm-pw-value">
                    {revealedId === selected.id && revealedSecret ? revealedSecret : '••••••••••••'}
                  </span>
                  <button
                    className={`pwm-icon-btn ${revealedId === selected.id ? 'active' : ''}`}
                    onClick={() => handleReveal(selected.id)}
                    title={revealedId === selected.id ? 'Verbergen' : '10s anzeigen'}
                  >👁</button>
                  <button
                    className={`pwm-icon-btn ${copiedId === selected.id ? 'active' : ''}`}
                    onClick={() => handleCopy(selected.id)}
                    title="Kopieren (30s Clipboard-Auto-Leerung)"
                  >{copiedId === selected.id ? '✓' : '📋'}</button>
                </div>
              </div>
              {selected.notes && (
                <div className="pwm-field">
                  <label>Notizen</label>
                  <span className="pwm-field-value pwm-notes">{selected.notes}</span>
                </div>
              )}
              <div className="pwm-field pwm-field-meta">
                <label>Erstellt</label>
                <span className="pwm-field-value pwm-meta-value">{new Date(selected.createdAt).toLocaleString('de-DE')}</span>
                <label>Geändert</label>
                <span className="pwm-field-value pwm-meta-value">{new Date(selected.updatedAt).toLocaleString('de-DE')}</span>
              </div>
            </div>
          </div>
        )}

        {/* Edit / New form */}
        {isEditing && (
          <div className="pwm-form-wrapper">
            <h2 className="pwm-form-title">{mode === 'new' ? 'Neuer Eintrag' : 'Eintrag bearbeiten'}</h2>
            <div className="pwm-form">
              <label>Name *</label>
              <input
                className="pwm-input"
                type="text"
                placeholder="z.B. GitHub"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
              <label>URL</label>
              <input
                className="pwm-input"
                type="url"
                placeholder="https://..."
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              />
              <label>Benutzername *</label>
              <input
                className="pwm-input"
                type="text"
                placeholder="E-Mail oder Benutzername"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
              />
              <label>Kategorie</label>
              <input
                className="pwm-input"
                type="text"
                list="pwm-categories"
                placeholder="z.B. Web"
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              />
              <datalist id="pwm-categories">
                {CATEGORY_SUGGESTIONS.map(c => <option key={c} value={c} />)}
              </datalist>
              <label>Passwort {mode === 'edit' ? '(leer lassen = nicht ändern)' : ''}</label>
              <div className="pwm-pw-input-row">
                <input
                  className="pwm-input pwm-pw-input"
                  type={showFormPassword ? 'text' : 'password'}
                  placeholder="Passwort eingeben oder generieren"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                />
                <button
                  type="button"
                  className={`pwm-icon-btn ${showFormPassword ? 'active' : ''}`}
                  onClick={() => setShowFormPassword(v => !v)}
                  title="Sichtbarkeit umschalten"
                >👁</button>
              </div>
              <div className="pwm-generator-toggle">
                <button
                  type="button"
                  className="pwm-btn pwm-btn-ghost"
                  onClick={() => setShowGenerator(v => !v)}
                >
                  {showGenerator ? '▾' : '▸'} Passwort-Generator
                </button>
              </div>
              {showGenerator && (
                <div className="pwm-generator">
                  <div className="pwm-gen-row">
                    <label>Länge: {genLength}</label>
                    <input
                      type="range"
                      min={8}
                      max={64}
                      value={genLength}
                      onChange={e => setGenLength(Number(e.target.value))}
                      className="pwm-gen-slider"
                    />
                  </div>
                  <div className="pwm-gen-checkboxes">
                    <label><input type="checkbox" checked={genUpper} onChange={e => setGenUpper(e.target.checked)} /> A–Z</label>
                    <label><input type="checkbox" checked={genLower} onChange={e => setGenLower(e.target.checked)} /> a–z</label>
                    <label><input type="checkbox" checked={genDigits} onChange={e => setGenDigits(e.target.checked)} /> 0–9</label>
                    <label><input type="checkbox" checked={genSpecial} onChange={e => setGenSpecial(e.target.checked)} /> !@#…</label>
                  </div>
                  <button type="button" className="pwm-btn pwm-btn-secondary" onClick={handleGenerate}>
                    ↻ Generieren
                  </button>
                </div>
              )}
              <label>Notizen</label>
              <textarea
                className="pwm-input pwm-notes-input"
                rows={3}
                placeholder="Optionale Notizen..."
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="pwm-form-actions">
              <button className="pwm-btn pwm-btn-primary" onClick={handleSave} disabled={saving || !form.name.trim() || !form.username.trim()}>
                {saving ? 'Speichern...' : 'Speichern'}
              </button>
              <button className="pwm-btn pwm-btn-secondary" onClick={handleCancel}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>
      </div>
      )}
    </div>
  );
}
