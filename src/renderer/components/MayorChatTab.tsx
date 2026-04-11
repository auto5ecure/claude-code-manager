import { useState, useEffect, useRef } from 'react';

export interface ChatMessage {
  id: string;
  timestamp: Date;
  role: 'user' | 'mayor';
  content: string;
  status?: 'DONE' | 'RUNNING' | 'BLOCKED' | 'SENT';
  rig?: string;
}

interface MayorChatTabProps {
  gastownInstalled: boolean;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

interface SettingsProject {
  id: string;
  name: string;
  path: string;
  type: 'tools' | 'projekt' | 'cowork';
  isRig: boolean;
  rigName?: string;
  prefix: string;
  subscribing: boolean;
  error?: string;
}

function autoPrefix(name: string): string {
  const parts = name.split(/[-_]/);
  if (parts.length > 1) return parts.map(p => p[0] || '').join('').substring(0, 3).toLowerCase();
  return name.substring(0, 2).toLowerCase();
}

export default function MayorChatTab({ gastownInstalled, messages, setMessages }: MayorChatTabProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProjects, setSettingsProjects] = useState<SettingsProject[]>([]);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState<SettingsProject | null>(null);
  const [mayorOutput, setMayorOutput] = useState('');
  const [mayorRunning, setMayorRunning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!gastownInstalled) return;

    async function pollMayor() {
      const result = await window.electronAPI?.mayorTmuxCapture?.();
      if (result?.output) {
        setMayorOutput(result.output);
        setMayorRunning(true);
        // Scroll output to bottom
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
      } else {
        setMayorRunning(false);
      }
    }

    pollMayor();
    pollRef.current = setInterval(pollMayor, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [gastownInstalled]);

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      timestamp: new Date(),
      role: 'user',
      content: text,
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setSending(true);

    const result = await window.electronAPI?.mayorNudge?.(text);
    if (result?.success) {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        timestamp: new Date(),
        role: 'mayor',
        content: 'Nachricht in der Mayor-Queue. Mayor verarbeitet im Hintergrund.',
        status: 'SENT',
      }]);
    } else {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        timestamp: new Date(),
        role: 'mayor',
        content: result?.error || 'Fehler beim Senden',
        status: 'BLOCKED',
      }]);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function formatTime(date: Date): string {
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  // ── Settings ──────────────────────────────────────────────

  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        id: '1',
        timestamp: new Date(),
        role: 'mayor',
        content: 'Mayor ist aktiv. Nachrichten werden per Nudge-Queue zugestellt.\nDie Mayor-Aktivität siehst du im Live-Fenster unten.',
        status: 'DONE',
      }]);
    }
  }, []);

  async function openSettings() {
    setShowSettings(true);
    setLoadingSettings(true);
    try {
      const [projects, coworkRepos] = await Promise.all([
        window.electronAPI?.getProjects() || [],
        window.electronAPI?.getCoworkRepositories() || [],
      ]);

      const toItem = async (id: string, name: string, path: string, type: SettingsProject['type']): Promise<SettingsProject> => {
        let isRig = false;
        let rigName: string | undefined;
        try {
          const status = await window.electronAPI?.getRigStatus?.(path);
          isRig = status?.isRig ?? false;
          rigName = status?.rigName;
        } catch { /* ignore */ }
        return { id, name, path, type, isRig, rigName, prefix: autoPrefix(name), subscribing: false };
      };

      const items = [
        ...await Promise.all(projects.map(p => toItem(p.id, p.name, p.path, p.type))),
        ...await Promise.all(coworkRepos.map(r => toItem(r.id, r.name, r.localPath, 'cowork'))),
      ];
      setSettingsProjects(items);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
    setLoadingSettings(false);
  }

  function updateProjectPrefix(id: string, prefix: string) {
    setSettingsProjects(prev =>
      prev.map(p => p.id === id ? { ...p, prefix: prefix.toLowerCase().substring(0, 3) } : p)
    );
  }

  async function subscribeProject(id: string) {
    const project = settingsProjects.find(p => p.id === id);
    if (!project || project.isRig) return;

    setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: true, error: undefined } : p));

    try {
      const rigName = project.name.replace(/-/g, '_');
      const result = await window.electronAPI?.addRig?.(project.path, rigName, project.prefix);
      if (result?.success) {
        setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, isRig: true, rigName, subscribing: false } : p));
      } else {
        setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p));
      }
    } catch (err) {
      setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: false, error: (err as Error).message } : p));
    }
  }

  async function unsubscribeProject(project: SettingsProject) {
    setConfirmUnsubscribe(null);
    const rigName = project.rigName || project.name.replace(/-/g, '_');

    setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: true, error: undefined } : p));

    try {
      const result = await window.electronAPI?.removeRig?.(rigName);
      if (result?.success) {
        setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, isRig: false, rigName: undefined, subscribing: false } : p));
      } else {
        setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p));
      }
    } catch (err) {
      setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: (err as Error).message } : p));
    }
  }

  // ── Render ────────────────────────────────────────────────

  if (!gastownInstalled) {
    return (
      <div className="mayor-tab mayor-not-installed">
        <div className="mayor-install-prompt">
          <h3>🏠 Mayor Chat</h3>
          <p>Gastown ist nicht installiert.</p>
          <p className="install-hint">
            Installiere Gastown: <code>brew install gastown</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mayor-tab">
      {/* Header */}
      <div className="mayor-header">
        <h2>🏠 Mayor</h2>
        <span className={`mayor-acp-status ${mayorRunning ? 'connected' : 'disconnected'}`}
          title={mayorRunning ? 'Mayor läuft' : 'Mayor nicht gefunden'}>
          {mayorRunning ? '● Live' : '○ Offline'}
        </span>
        <button className="mayor-settings-btn" onClick={openSettings} title="Projekte als Rigs verwalten">
          ⚙
        </button>
      </div>

      {/* Settings overlay */}
      {showSettings && (
        <div className="mayor-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="mayor-settings-panel" onClick={e => e.stopPropagation()}>
            <div className="mayor-settings-header">
              <h3>Projekte als Rigs verwalten</h3>
              <button className="mayor-settings-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="mayor-settings-body">
              {loadingSettings ? (
                <div className="mayor-settings-loading">Lade Projekte...</div>
              ) : settingsProjects.length === 0 ? (
                <div className="mayor-settings-empty">Keine Projekte gefunden.</div>
              ) : (
                <div className="mayor-settings-list">
                  {(['tools', 'projekt', 'cowork'] as const).map(groupType => {
                    const group = settingsProjects.filter(p => p.type === groupType);
                    if (group.length === 0) return null;
                    const label = groupType === 'cowork' ? 'Cowork' : groupType === 'tools' ? 'Tools' : 'Projekte';
                    return (
                      <div key={groupType}>
                        <div className="mayor-settings-group-label">{label}</div>
                        {group.map(project => (
                          <div key={project.id} className={`mayor-settings-row ${project.isRig ? 'is-rig' : ''}`}>
                            <span className={`mayor-settings-dot ${project.isRig ? 'active' : ''}`}>
                              {project.subscribing ? '…' : project.isRig ? '●' : '○'}
                            </span>
                            <span className="mayor-settings-row-name">{project.name}</span>
                            {project.isRig ? (
                              <>
                                {project.rigName && <span className="mayor-settings-row-tag">{project.rigName}</span>}
                                <button
                                  className="mayor-settings-unsub-btn"
                                  onClick={() => setConfirmUnsubscribe(project)}
                                  disabled={project.subscribing}
                                  title="Rig entfernen"
                                >−</button>
                              </>
                            ) : (
                              <>
                                <input
                                  type="text"
                                  className="mayor-settings-prefix"
                                  value={project.prefix}
                                  onChange={e => updateProjectPrefix(project.id, e.target.value)}
                                  maxLength={3}
                                  placeholder="abc"
                                  disabled={project.subscribing}
                                />
                                <button
                                  className="mayor-settings-sub-btn"
                                  onClick={() => subscribeProject(project.id)}
                                  disabled={project.subscribing || !project.prefix}
                                >
                                  {project.subscribing ? '…' : '+'}
                                </button>
                              </>
                            )}
                            {project.error && <span className="mayor-settings-row-error" title={project.error}>!</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm unsubscribe */}
      {confirmUnsubscribe && (
        <div className="mayor-confirm-overlay" onClick={() => setConfirmUnsubscribe(null)}>
          <div className="mayor-confirm-modal" onClick={e => e.stopPropagation()}>
            <h4>Rig entfernen?</h4>
            <p><strong>{confirmUnsubscribe.rigName || confirmUnsubscribe.name}</strong> aus Gastown entfernen? Dies löscht den Symlink und die Registrierung.</p>
            <div className="mayor-confirm-actions">
              <button className="mayor-confirm-cancel" onClick={() => setConfirmUnsubscribe(null)}>Abbrechen</button>
              <button className="mayor-confirm-remove" onClick={() => unsubscribeProject(confirmUnsubscribe)}>Entfernen</button>
            </div>
          </div>
        </div>
      )}

      {/* Sent messages */}
      <div className="mayor-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`mayor-message ${msg.role}`}>
            <div className="message-header">
              <span className="message-role">{msg.role === 'user' ? '👤 Du' : '🏠 Mayor'}</span>
              <span className="message-time">{formatTime(msg.timestamp)}</span>
              {msg.status && msg.status !== 'SENT' && (
                <span className={`message-status ${msg.status.toLowerCase()}`}>{msg.status}</span>
              )}
              {msg.status === 'SENT' && <span className="message-status sent">GESENDET</span>}
            </div>
            <div className="message-content">
              {msg.content.split('\n').map((line, i, arr) => (
                <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
              ))}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Mayor live output */}
      <div className="mayor-live-section">
        <div className="mayor-live-header">
          <span className="mayor-live-title">Mayor Live</span>
          {mayorRunning && <span className="mayor-live-dot">●</span>}
        </div>
        <div className="mayor-live-output" ref={outputRef}>
          <pre>{mayorOutput || 'Mayor nicht erreichbar'}</pre>
        </div>
      </div>

      {/* Input */}
      <div className="mayor-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nachricht an Mayor senden (Enter)..."
          className="mayor-input"
          rows={2}
          disabled={sending}
        />
        <button
          className="mayor-send-btn"
          onClick={() => sendMessage(input)}
          disabled={!input.trim() || sending}
        >
          {sending ? '...' : '↵'}
        </button>
      </div>
    </div>
  );
}
