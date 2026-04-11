import { useState, useEffect, useRef } from 'react';

export interface ChatMessage {
  id: string;
  timestamp: Date;
  role: 'user' | 'mayor';
  content: string;
  status?: 'DONE' | 'RUNNING' | 'BLOCKED';
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
  const [filterContext, setFilterContext] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProjects, setSettingsProjects] = useState<SettingsProject[]>([]);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState<SettingsProject | null>(null);
  const [acpMode, setAcpMode] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamBuffer = useRef('');
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const quickActions = [
    { label: 'Status', command: 'status' },
    { label: 'Beads', command: 'beads list' },
    { label: 'Rigs', command: 'rig list' },
    { label: 'Help', command: 'help' },
  ];

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: '1',
          timestamp: new Date(),
          role: 'mayor',
          content: 'Willkommen! Ich bin der Mayor. Wie kann ich helfen?\n\nVerfügbare Befehle:\n- status - Zeige Gastown Status\n- beads list - Liste offene Issues\n- rig list - Liste alle Rigs\n- help - Zeige Hilfe',
        }
      ]);
    }
  }, []);

  useEffect(() => {
    if (!gastownInstalled) return;

    // Start Mayor ACP session
    window.electronAPI?.mayorAcpStart?.().then(result => {
      setAcpMode(result?.success ?? false);
    });

    // Stream output → buffer → finalize as message
    const offOutput = window.electronAPI?.onMayorAcpOutput?.((text) => {
      streamBuffer.current += text;
      setStreamingText(streamBuffer.current);
      setSending(true);

      if (streamTimer.current) clearTimeout(streamTimer.current);
      streamTimer.current = setTimeout(() => {
        const content = streamBuffer.current.trim();
        if (content) {
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            timestamp: new Date(),
            role: 'mayor',
            content,
            status: 'DONE',
          }]);
        }
        streamBuffer.current = '';
        setStreamingText('');
        setSending(false);
      }, 1000);
    });

    const offExit = window.electronAPI?.onMayorAcpExit?.(() => {
      setAcpMode(false);
    });

    return () => {
      offOutput?.();
      offExit?.();
      if (streamTimer.current) clearTimeout(streamTimer.current);
    };
  }, [gastownInstalled]);

  async function openSettings() {
    setShowSettings(true);
    setLoadingSettings(true);
    try {
      const [projects, coworkRepos] = await Promise.all([
        window.electronAPI?.getProjects() || [],
        window.electronAPI?.getCoworkRepositories() || [],
      ]);

      const toSettingsProject = async (id: string, name: string, path: string, type: SettingsProject['type']): Promise<SettingsProject> => {
        let isRig = false;
        let rigName: string | undefined;
        try {
          const status = await window.electronAPI?.getRigStatus?.(path);
          isRig = status?.isRig ?? false;
          rigName = status?.rigName;
        } catch { /* ignore */ }
        return { id, name, path, type, isRig, rigName, prefix: autoPrefix(name), subscribing: false };
      };

      const projectItems = await Promise.all(
        projects.map(p => toSettingsProject(p.id, p.name, p.path, p.type))
      );
      const coworkItems = await Promise.all(
        coworkRepos.map(r => toSettingsProject(r.id, r.name, r.localPath, 'cowork'))
      );

      setSettingsProjects([...projectItems, ...coworkItems]);
    } catch (err) {
      console.error('Failed to load settings projects:', err);
    }
    setLoadingSettings(false);
  }

  async function unsubscribeProject(project: SettingsProject) {
    setConfirmUnsubscribe(null);
    const rigName = project.rigName || project.name.replace(/-/g, '_');

    setSettingsProjects(prev =>
      prev.map(p => p.id === project.id ? { ...p, subscribing: true, error: undefined } : p)
    );

    try {
      const result = await window.electronAPI?.removeRig?.(rigName);
      if (result?.success) {
        setSettingsProjects(prev =>
          prev.map(p => p.id === project.id ? { ...p, isRig: false, rigName: undefined, subscribing: false } : p)
        );
      } else {
        setSettingsProjects(prev =>
          prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p)
        );
      }
    } catch (err) {
      setSettingsProjects(prev =>
        prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: (err as Error).message } : p)
      );
    }
  }

  function updateProjectPrefix(id: string, prefix: string) {
    setSettingsProjects(prev =>
      prev.map(p => p.id === id ? { ...p, prefix: prefix.toLowerCase().substring(0, 3) } : p)
    );
  }

  async function subscribeProject(id: string) {
    const project = settingsProjects.find(p => p.id === id);
    if (!project || project.isRig) return;

    setSettingsProjects(prev =>
      prev.map(p => p.id === id ? { ...p, subscribing: true, error: undefined } : p)
    );

    try {
      const rigName = project.name.replace(/-/g, '_');
      const result = await window.electronAPI?.addRig?.(project.path, rigName, project.prefix);
      if (result?.success) {
        setSettingsProjects(prev =>
          prev.map(p => p.id === id ? { ...p, isRig: true, rigName, subscribing: false } : p)
        );
      } else {
        setSettingsProjects(prev =>
          prev.map(p => p.id === id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p)
        );
      }
    } catch (err) {
      setSettingsProjects(prev =>
        prev.map(p => p.id === id ? { ...p, subscribing: false, error: (err as Error).message } : p)
      );
    }
  }

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

    if (acpMode) {
      // ACP mode: stream response via event listener
      setSending(true);
      const result = await window.electronAPI?.mayorAcpSend?.(text);
      if (!result?.success) {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date(),
          role: 'mayor',
          content: result?.error || 'Fehler beim Senden',
          status: 'BLOCKED',
        }]);
        setSending(false);
      }
      // Response arrives via onMayorAcpOutput listener
    } else {
      // Fallback: one-shot gt command
      setSending(true);
      try {
        const response = await executeMayorCommand(text);
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date(),
          role: 'mayor',
          content: response.output,
          status: response.status,
        }]);
      } catch (err) {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date(),
          role: 'mayor',
          content: `Fehler: ${(err as Error).message}`,
          status: 'BLOCKED',
        }]);
      }
      setSending(false);
    }
  }

  async function executeMayorCommand(command: string): Promise<{ output: string; status?: 'DONE' | 'RUNNING' | 'BLOCKED' }> {
    const result = await window.electronAPI?.executeGtCommand?.(command);
    if (!result) {
      return { output: 'Fehler: electronAPI nicht verfügbar.', status: 'BLOCKED' };
    }
    return {
      output: result.output,
      status: result.status === 'done' ? 'DONE' : 'BLOCKED',
    };
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

  if (!gastownInstalled) {
    return (
      <div className="mayor-tab mayor-not-installed">
        <div className="mayor-install-prompt">
          <h3>🏠 Mayor Chat</h3>
          <p>Gastown ist nicht installiert.</p>
          <p className="install-hint">
            Installiere Gastown um den Mayor Chat zu nutzen:
            <code>brew install gastown</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mayor-tab">
      <div className="mayor-header">
        <h2>🏠 Mayor</h2>
        <span className={`mayor-acp-status ${acpMode ? 'connected' : 'disconnected'}`}
          title={acpMode ? 'ACP verbunden' : 'Kein ACP – Fallback-Modus'}>
          {acpMode ? '● ACP' : '○ ACP'}
        </span>
        <select
          value={filterContext}
          onChange={(e) => setFilterContext(e.target.value)}
          className="mayor-context-filter"
        >
          <option value="">Alle Contexts</option>
          <option value="privat">privat</option>
          <option value="autosecure">autosecure</option>
          <option value="TimonEsserIT">TimonEsserIT</option>
        </select>
        <button
          className="mayor-settings-btn"
          onClick={openSettings}
          title="Projekte als Rigs verwalten"
        >
          ⚙
        </button>
      </div>

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
                                {project.rigName && (
                                  <span className="mayor-settings-row-tag">{project.rigName}</span>
                                )}
                                <button
                                  className="mayor-settings-unsub-btn"
                                  onClick={() => setConfirmUnsubscribe(project)}
                                  disabled={project.subscribing}
                                  title="Rig entfernen"
                                >
                                  −
                                </button>
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
                            {project.error && (
                              <span className="mayor-settings-row-error" title={project.error}>!</span>
                            )}
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

      {confirmUnsubscribe && (
        <div className="mayor-confirm-overlay" onClick={() => setConfirmUnsubscribe(null)}>
          <div className="mayor-confirm-modal" onClick={e => e.stopPropagation()}>
            <h4>Rig entfernen?</h4>
            <p>
              <strong>{confirmUnsubscribe.rigName || confirmUnsubscribe.name}</strong> aus Gastown entfernen?
              Dies löscht den Symlink und die Registrierung.
            </p>
            <div className="mayor-confirm-actions">
              <button className="mayor-confirm-cancel" onClick={() => setConfirmUnsubscribe(null)}>
                Abbrechen
              </button>
              <button className="mayor-confirm-remove" onClick={() => unsubscribeProject(confirmUnsubscribe)}>
                Entfernen
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mayor-quick-actions">
        {quickActions.map(action => (
          <button
            key={action.command}
            className="quick-action-btn"
            onClick={() => sendMessage(action.command)}
            disabled={sending}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="mayor-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`mayor-message ${msg.role}`}>
            <div className="message-header">
              <span className="message-role">
                {msg.role === 'user' ? '👤 Du' : '🏠 Mayor'}
              </span>
              <span className="message-time">{formatTime(msg.timestamp)}</span>
              {msg.status && (
                <span className={`message-status ${msg.status.toLowerCase()}`}>
                  {msg.status}
                </span>
              )}
            </div>
            <div className="message-content">
              {msg.content.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  {i < msg.content.split('\n').length - 1 && <br />}
                </span>
              ))}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="mayor-message mayor streaming">
            <div className="message-header">
              <span className="message-role">🏠 Mayor</span>
              <span className="message-time">{formatTime(new Date())}</span>
              <span className="mayor-streaming-indicator">●●●</span>
            </div>
            <div className="message-content">
              {streamingText.split('\n').map((line, i, arr) => (
                <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="mayor-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nachricht an Mayor..."
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
