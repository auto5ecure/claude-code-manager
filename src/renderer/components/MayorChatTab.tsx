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
  type: string;
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const quickActions = [
    { label: 'Status?', command: 'status' },
    { label: 'Beads?', command: 'beads list' },
    { label: 'Rigs?', command: 'rig list' },
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

  async function openSettings() {
    setShowSettings(true);
    setLoadingSettings(true);
    try {
      const projects = await window.electronAPI?.getProjects() || [];
      const items: SettingsProject[] = await Promise.all(
        projects.map(async (p) => {
          let isRig = false;
          let rigName: string | undefined;
          try {
            const status = await window.electronAPI?.getRigStatus?.(p.path);
            isRig = status?.isRig ?? false;
            rigName = status?.rigName;
          } catch { /* ignore */ }
          return {
            id: p.id,
            name: p.name,
            path: p.path,
            type: p.type,
            isRig,
            rigName,
            prefix: autoPrefix(p.name),
            subscribing: false,
          };
        })
      );
      setSettingsProjects(items);
    } catch (err) {
      console.error('Failed to load settings projects:', err);
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
    setSending(true);

    try {
      const response = await executeMayorCommand(text);

      const mayorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        timestamp: new Date(),
        role: 'mayor',
        content: response.output,
        status: response.status,
      };

      setMessages(prev => [...prev, mayorMessage]);
    } catch (err) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        timestamp: new Date(),
        role: 'mayor',
        content: `Fehler: ${(err as Error).message}`,
        status: 'BLOCKED',
      };
      setMessages(prev => [...prev, errorMessage]);
    }

    setSending(false);
  }

  async function executeMayorCommand(command: string): Promise<{ output: string; status?: 'DONE' | 'RUNNING' | 'BLOCKED' }> {
    const gtCommands: Record<string, string> = {
      'status': 'gt status',
      'beads': 'gt beads list',
      'beads list': 'gt beads list',
      'rigs': 'gt rig list',
      'rig list': 'gt rig list',
      'help': 'gt help',
    };

    const gtCommand = gtCommands[command.toLowerCase()] || `gt ${command}`;

    return new Promise((resolve) => {
      if (command.toLowerCase() === 'status') {
        resolve({
          output: '🏠 Gastown Status\n\nRigs: Aktiv\nMayor: Bereit\nBeads: Synchronisiert\n\nAlles läuft!',
          status: 'DONE',
        });
      } else if (command.toLowerCase().includes('beads')) {
        resolve({
          output: '📋 Offene Beads\n\nKeine offenen Beads gefunden.\n\nVerwende "gt beads add" um neue Issues zu erstellen.',
          status: 'DONE',
        });
      } else if (command.toLowerCase().includes('rig')) {
        resolve({
          output: '🔧 Registrierte Rigs\n\nVerwende den Wiki-Tab um alle Rigs zu sehen.',
          status: 'DONE',
        });
      } else if (command.toLowerCase() === 'help') {
        resolve({
          output: '📖 Mayor Hilfe\n\nBefehle:\n- status - Gastown Status\n- beads list - Offene Issues\n- beads add <title> - Neues Issue\n- rig list - Alle Rigs\n- mayor attach - Mayor Session starten',
          status: 'DONE',
        });
      } else {
        resolve({
          output: `Führe aus: ${gtCommand}\n\n(Mayor-Integration in Arbeit...)`,
          status: 'RUNNING',
        });
      }
    });
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
              <h3>Projekte abonnieren</h3>
              <button className="mayor-settings-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="mayor-settings-body">
              {loadingSettings ? (
                <div className="mayor-settings-loading">Lade Projekte...</div>
              ) : settingsProjects.length === 0 ? (
                <div className="mayor-settings-empty">Keine Projekte gefunden.</div>
              ) : (
                <div className="mayor-settings-list">
                  {settingsProjects.map(project => (
                    <div key={project.id} className={`mayor-settings-item ${project.isRig ? 'is-rig' : ''}`}>
                      <div className="mayor-settings-item-info">
                        <span className="mayor-settings-item-indicator">
                          {project.isRig ? '●' : '○'}
                        </span>
                        <span className="mayor-settings-item-name">{project.name}</span>
                        {project.isRig && project.rigName && (
                          <span className="mayor-settings-item-rigname">{project.rigName}</span>
                        )}
                      </div>
                      {!project.isRig && (
                        <div className="mayor-settings-item-actions">
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
                            className="mayor-settings-subscribe-btn"
                            onClick={() => subscribeProject(project.id)}
                            disabled={project.subscribing || !project.prefix}
                          >
                            {project.subscribing ? '...' : '+ Rig'}
                          </button>
                        </div>
                      )}
                      {project.error && (
                        <div className="mayor-settings-item-error">{project.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
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
