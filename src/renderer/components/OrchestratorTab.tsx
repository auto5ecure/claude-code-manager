import { useState, useEffect, useRef, useCallback } from 'react';

interface Project {
  id: string;
  path: string;
  name: string;
  type: 'tools' | 'projekt';
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface OrchestratorTabProps {
  projects: Project[];
}

const STORAGE_KEY = 'orchestrator-conversation';

export default function OrchestratorTab({ projects }: OrchestratorTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingContentRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Load conversation from localStorage
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setMessages(JSON.parse(saved));
      }
    } catch { /* ignore */ }
    // Select all projects by default
    setSelectedProjects(new Set(projects.map(p => p.path)));
  }, []);

  useEffect(() => {
    // Save conversation to localStorage
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleToggleProject = (projectPath: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  };

  const handleSelectAllProjects = () => {
    setSelectedProjects(new Set(projects.map(p => p.path)));
  };

  const handleDeselectAllProjects = () => {
    setSelectedProjects(new Set());
  };

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || streaming) return;
    setError(null);
    setSavedPath(null);

    const userMessage: Message = {
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    setStreamingContent('');
    streamingContentRef.current = '';

    // Subscribe to streaming chunks
    const unsubscribe = window.electronAPI?.onOrchestratorChunk((chunk) => {
      if (chunk === null) {
        // End of stream
        const finalContent = streamingContentRef.current;
        setStreaming(false);
        setStreamingContent('');
        if (finalContent) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: finalContent,
            timestamp: new Date().toISOString(),
          }]);
        }
        unsubscribe?.();
      } else {
        streamingContentRef.current += chunk;
        setStreamingContent(prev => prev + chunk);
      }
    });

    const result = await window.electronAPI?.orchestratorChat(
      newMessages.map(m => ({ role: m.role, content: m.content })),
      Array.from(selectedProjects)
    );

    if (!result?.success) {
      setStreaming(false);
      setStreamingContent('');
      setError(result?.error || 'Unbekannter Fehler');
      unsubscribe?.();
    }
  }, [messages, streaming, selectedProjects]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleQuickAction = (action: string) => {
    sendMessage(action);
  };

  const handleClearConversation = () => {
    setMessages([]);
    setStreamingContent('');
    setSavedPath(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleSaveLog = async () => {
    if (messages.length === 0) return;
    setSaving(true);
    const title = `Orchestrator-Chat ${new Date().toLocaleDateString('de-DE')}`;
    const content = messages.map(m =>
      `## ${m.role === 'user' ? 'Nutzer' : 'Orchestrator'} *(${new Date(m.timestamp).toLocaleString('de-DE')})*\n\n${m.content}`
    ).join('\n\n---\n\n');

    const result = await window.electronAPI?.saveOrchestratorLog(title, content);
    setSaving(false);
    if (result?.success) {
      setSavedPath(result.path || 'Gespeichert');
    } else {
      setError(result?.error || 'Fehler beim Speichern');
    }
  };

  const renderMarkdown = (text: string) => {
    // Simple markdown rendering - code blocks, bold, italic
    return text
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[h|p|l|p|c])(.+)$/gm, '$1')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  };

  return (
    <div className="orchestrator-tab">
      {/* Header */}
      <div className="orchestrator-header">
        <div className="orchestrator-title">
          <span>Orchestrator</span>
          <span className="orchestrator-subtitle">Claude MC – Projektübergreifend</span>
        </div>
        <div className="orchestrator-header-actions">
          <span className="orchestrator-cli-badge">Claude CLI · Max Abo</span>
          <button className="orch-btn-small" onClick={handleSaveLog} disabled={saving || messages.length === 0}>
            {saving ? 'Speichere...' : '💾 Speichern'}
          </button>
          <button className="orch-btn-small" onClick={handleClearConversation} disabled={messages.length === 0}>
            🗑 Leeren
          </button>
        </div>
      </div>

      {savedPath && (
        <div className="orchestrator-saved-notice">
          ✓ Gespeichert: {savedPath}
        </div>
      )}

      <div className="orchestrator-body">
        {/* Project Context Selector */}
        <div className="orchestrator-context-panel">
          <div className="context-panel-header">
            <span>Kontext</span>
            <div className="context-panel-actions">
              <button onClick={handleSelectAllProjects} className="orch-link">Alle</button>
              <button onClick={handleDeselectAllProjects} className="orch-link">Keine</button>
            </div>
          </div>
          <div className="context-projects">
            {projects.map(p => (
              <label key={p.path} className="context-project-item">
                <input
                  type="checkbox"
                  checked={selectedProjects.has(p.path)}
                  onChange={() => handleToggleProject(p.path)}
                />
                <span className={`project-type-badge badge-${p.type}`}>{p.type === 'tools' ? 'T' : 'P'}</span>
                <span className="context-project-name">{p.name}</span>
              </label>
            ))}
            {projects.length === 0 && (
              <p className="context-empty">Keine Projekte verfügbar</p>
            )}
          </div>

          {/* Quick Actions */}
          <div className="quick-actions">
            <p className="quick-actions-label">Schnellaktionen</p>
            <button className="quick-action-btn" onClick={() => handleQuickAction('Analysiere alle Projekte und gib einen Überblick über den aktuellen Stand.')}>
              Analysiere alle Projekte
            </button>
            <button className="quick-action-btn" onClick={() => handleQuickAction('Welche Tasks und offenen Punkte gibt es projektübergreifend? Liste sie strukturiert auf.')}>
              Offene Tasks
            </button>
            <button className="quick-action-btn" onClick={() => handleQuickAction('Erstelle eine Übersicht aller Projekte mit Beschreibung, Typ und aktuellem Status.')}>
              Erstelle Übersicht
            </button>
          </div>
        </div>

        {/* Chat Area */}
        <div className="orchestrator-chat">
          <div className="orchestrator-messages">
            {messages.length === 0 && !streaming && (
              <div className="orchestrator-empty">
                <p>Kein Chat-Verlauf. Stelle eine Frage oder nutze eine Schnellaktion.</p>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`orchestrator-message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'Du' : 'Orchestrator'}
                </div>
                <div
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
                <div className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString('de-DE')}
                </div>
              </div>
            ))}
            {streaming && streamingContent && (
              <div className="orchestrator-message assistant streaming">
                <div className="message-role">Orchestrator</div>
                <div
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }}
                />
                <span className="streaming-cursor" />
              </div>
            )}
            {streaming && !streamingContent && (
              <div className="orchestrator-message assistant streaming">
                <div className="message-role">Orchestrator</div>
                <div className="message-content typing-indicator">
                  <span /><span /><span />
                </div>
              </div>
            )}
            {error && (
              <div className="orchestrator-error">{error}</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form className="orchestrator-input-form" onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              className="orchestrator-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Nachricht eingeben... (Enter zum Senden, Shift+Enter für neue Zeile)"
              disabled={streaming}
              rows={3}
            />
            <button
              type="submit"
              className="orchestrator-send-btn btn-primary"
              disabled={streaming || !input.trim()}
            >
              {streaming ? '...' : 'Senden'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
