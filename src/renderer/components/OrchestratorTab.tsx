import { useState, useEffect, useRef, useCallback } from 'react';
import { startLoading, stopLoading } from '../utils/loading';

interface Project {
  id: string;
  path: string;
  name: string;
  type: 'tools' | 'projekt';
}

interface CoworkRepo {
  id: string;
  name: string;
  localPath: string;
  githubUrl: string;
  branch: string;
  hasCLAUDEmd: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface OrchestratorTabProps {
  projects: Project[];
  coworkRepos: CoworkRepo[];
  pendingAgentContext?: { agentId: string; output: string; projectName: string } | null;
  onAgentContextConsumed?: () => void;
  onOpenAgents?: () => void;
}

const STORAGE_KEY = 'orchestrator-conversation';
const CONTEXT_KEY = 'orchestrator-selected-contexts';

function ClaudeMCIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mcIconGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
        <linearGradient id="mcSparkGrad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#e9d5ff" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      {/* Rounded square base */}
      <rect width="32" height="32" rx="9" fill="url(#mcIconGrad)" />
      {/* Inner subtle glow ring */}
      <rect x="2" y="2" width="28" height="28" rx="7.5" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      {/* Sparkle top-right */}
      <path
        d="M24.5 4.5 L25.4 7.1 L28 8 L25.4 8.9 L24.5 11.5 L23.6 8.9 L21 8 L23.6 7.1 Z"
        fill="url(#mcSparkGrad)"
      />
      {/* Small dot bottom-left accent */}
      <circle cx="6" cy="26" r="1.5" fill="rgba(255,255,255,0.3)" />
      {/* MC text */}
      <text
        x="15"
        y="22"
        textAnchor="middle"
        fill="white"
        fontFamily="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
        fontWeight="900"
        fontSize="13"
        letterSpacing="0.3"
      >
        MC
      </text>
    </svg>
  );
}

export { ClaudeMCIcon };

// Module-level markdown cache – shared across renders, auto-cleared at 200 entries
const mdCache = new Map<string, string>();

export default function OrchestratorTab({ projects, coworkRepos, pendingAgentContext, onAgentContextConsumed, onOpenAgents }: OrchestratorTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryUpdating, setMemoryUpdating] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const assistantMsgCountRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingContentRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track which paths have been seen to auto-select newly arriving ones
  const seenPathsRef = useRef<Set<string>>(new Set());

  // All selectable paths: projects + cowork repos
  const allPaths = [
    ...projects.map(p => p.path),
    ...coworkRepos.map(r => r.localPath),
  ];

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved));
    } catch { /* ignore */ }

    try {
      const savedCtx = localStorage.getItem(CONTEXT_KEY);
      if (savedCtx) setSelectedProjects(new Set(JSON.parse(savedCtx)));
    } catch { /* ignore */ }

    // Load persistent memory
    window.electronAPI?.memoryGet().then(res => {
      if (res?.content) setMemory(res.content);
    });

    // Listen for background memory updates
    const unsub = window.electronAPI?.onMemoryUpdated((content) => {
      setMemory(content);
      setMemoryUpdating(false);
    });
    return () => unsub?.();
  }, []);

  // Auto-select any paths that arrive for the first time (handles projects and
  // coworkRepos loading in separate render cycles, and newly added projects).
  // Uses a ref so previously deselected paths are never force-re-added.
  useEffect(() => {
    if (allPaths.length === 0) return;
    const newPaths = allPaths.filter(p => !seenPathsRef.current.has(p));
    if (newPaths.length === 0) return;
    newPaths.forEach(p => seenPathsRef.current.add(p));
    setSelectedProjects(prev => {
      const next = new Set(prev);
      newPaths.forEach(p => next.add(p));
      return next;
    });
  }, [allPaths.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(Array.from(selectedProjects)));
  }, [selectedProjects]);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }

    // Count new assistant messages and trigger memory update every 5
    const assistantCount = messages.filter(m => m.role === 'assistant').length;
    if (assistantCount > 0 && assistantCount !== assistantMsgCountRef.current) {
      assistantMsgCountRef.current = assistantCount;
      if (assistantCount % 5 === 0) {
        triggerMemoryUpdate(messages);
      }
    }
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  useEffect(() => {
    if (!pendingAgentContext) return;
    const { output, projectName } = pendingAgentContext;
    const truncated = output.length > 3000 ? output.slice(0, 3000) + '\n\n[...gekürzt]' : output;
    const content = `Sub-Agent Ergebnis von **${projectName}**:\n\n\`\`\`\n${truncated}\n\`\`\``;
    setMessages(prev => [...prev, {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }]);
    onAgentContextConsumed?.();
  }, [pendingAgentContext]);

  const triggerMemoryUpdate = (msgs: Message[]) => {
    if (memoryUpdating || msgs.length < 2) return;
    setMemoryUpdating(true);
    window.electronAPI?.memoryUpdate(
      msgs.map(m => ({ role: m.role, content: m.content }))
    ).then(res => {
      if (!res?.success) setMemoryUpdating(false);
    });
  };

  const handleTogglePath = (p: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const handleSelectAll = () => setSelectedProjects(new Set(allPaths));
  const handleDeselectAll = () => setSelectedProjects(new Set());

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
    startLoading('Orchestrator denkt...');

    const unsubscribe = window.electronAPI?.onOrchestratorChunk((chunk) => {
      if (chunk === null) {
        const finalContent = streamingContentRef.current;
        setStreaming(false);
        stopLoading();
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
      stopLoading();
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

  const handleClearConversation = () => {
    // Save to memory before clearing
    if (messages.length >= 2) {
      triggerMemoryUpdate(messages);
    }
    setMessages([]);
    setStreamingContent('');
    setSavedPath(null);
    assistantMsgCountRef.current = 0;
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleSaveLog = async () => {
    if (messages.length === 0) return;
    setSaving(true);
    const title = `ClaudeMC Chat ${new Date().toLocaleDateString('de-DE')}`;
    const content = messages.map(m =>
      `## ${m.role === 'user' ? 'Nutzer' : 'ClaudeMC'} *(${new Date(m.timestamp).toLocaleString('de-DE')})*\n\n${m.content}`
    ).join('\n\n---\n\n');

    const result = await window.electronAPI?.saveOrchestratorLog(title, content);
    setSaving(false);
    if (result?.success) {
      setSavedPath(result.path || 'Gespeichert');
    } else {
      setError(result?.error || 'Fehler beim Speichern');
    }
  };

  const renderMarkdown = useCallback((text: string): string => {
    if (mdCache.has(text)) return mdCache.get(text)!;
    const html = text
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/<\/ul>\s*<ul>/g, '')
      .replace(/\n\n/g, '</p><p>');
    // Only cache completed (non-streaming) messages to avoid unbounded growth
    if (mdCache.size > 200) mdCache.clear();
    mdCache.set(text, html);
    return html;
  }, []);

  return (
    <div className="orchestrator-tab">
      {/* Header */}
      <div className="orchestrator-header">
        <div className="orchestrator-title">
          <div className="orchestrator-title-row">
            <ClaudeMCIcon size={22} />
            <span className="orchestrator-title-name">ClaudeMC</span>
          </div>
          <span className="orchestrator-subtitle">Projektübergreifender Assistent</span>
        </div>
        <div className="orchestrator-header-actions">
          <span className="orchestrator-cli-badge">Max Abo · Opus</span>
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
        {/* Context Panel */}
        <div className="orchestrator-context-panel">
          <div className="context-panel-header">
            <span>Kontext</span>
            <div className="context-panel-actions">
              <button onClick={handleSelectAll} className="orch-link">Alle</button>
              <button onClick={handleDeselectAll} className="orch-link">Keine</button>
            </div>
          </div>
          <div className="context-projects">
            {/* Regular Projects */}
            {projects.length > 0 && (
              <>
                <div className="context-group-label">Projekte</div>
                {projects.map(p => (
                  <label key={p.path} className="context-project-item">
                    <input
                      type="checkbox"
                      checked={selectedProjects.has(p.path)}
                      onChange={() => handleTogglePath(p.path)}
                    />
                    <span className={`project-type-badge badge-${p.type}`}>{p.type === 'tools' ? 'T' : 'P'}</span>
                    <span className="context-project-name">{p.name}</span>
                  </label>
                ))}
              </>
            )}

            {/* Cowork Repos */}
            {coworkRepos.length > 0 && (
              <>
                <div className="context-group-label">Coworking</div>
                {coworkRepos.map(r => (
                  <label key={r.localPath} className="context-project-item">
                    <input
                      type="checkbox"
                      checked={selectedProjects.has(r.localPath)}
                      onChange={() => handleTogglePath(r.localPath)}
                    />
                    <span className="project-type-badge badge-cowork">C</span>
                    <span className="context-project-name">{r.name}</span>
                  </label>
                ))}
              </>
            )}

            {allPaths.length === 0 && (
              <p className="context-empty">Keine Projekte verfügbar</p>
            )}
          </div>

          {/* Memory Panel */}
          <div className="memory-panel">
            <button className="memory-panel-header" onClick={() => setMemoryOpen(o => !o)}>
              <span>
                {memoryUpdating ? '🔄' : '🧠'} Gedächtnis
              </span>
              <span className="memory-panel-chevron">{memoryOpen ? '▲' : '▼'}</span>
            </button>
            {memoryOpen && (
              <div className="memory-panel-body">
                {memory ? (
                  <pre className="memory-content">{memory}</pre>
                ) : (
                  <p className="memory-empty">
                    {memoryUpdating ? 'Wird aufgebaut...' : 'Noch kein Gedächtnis. Entsteht automatisch nach 5 Nachrichten.'}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="quick-actions">
            <p className="quick-actions-label">Schnellaktionen</p>
            <button className="quick-action-btn" onClick={() => sendMessage('Analysiere alle Projekte und gib einen Überblick über den aktuellen Stand.')}>
              Analysiere alle Projekte
            </button>
            <button className="quick-action-btn" onClick={() => sendMessage('Welche Tasks und offenen Punkte gibt es projektübergreifend? Liste sie strukturiert auf.')}>
              Offene Tasks
            </button>
            <button className="quick-action-btn" onClick={() => sendMessage('Erstelle eine Übersicht aller Projekte mit Beschreibung, Typ und aktuellem Status.')}>
              Erstelle Übersicht
            </button>
            <button className="quick-action-btn" onClick={() => onOpenAgents?.()}>
              🤖 Sub-Agent starten
            </button>
          </div>
        </div>

        {/* Chat Area */}
        <div className="orchestrator-chat">
          <div className="orchestrator-messages">
            {messages.length === 0 && !streaming && (
              <div className="orchestrator-empty">
                <ClaudeMCIcon size={48} />
                <p>Stelle eine Frage oder nutze eine Schnellaktion.</p>
                <p className="orchestrator-empty-sub">
                  {selectedProjects.size} von {allPaths.length} Quellen im Kontext
                </p>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`orchestrator-message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'Du' : 'ClaudeMC'}
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
                <div className="message-role">ClaudeMC</div>
                <div
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }}
                />
                <span className="streaming-cursor" />
              </div>
            )}
            {streaming && !streamingContent && (
              <div className="orchestrator-message assistant streaming">
                <div className="message-role">ClaudeMC</div>
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
              placeholder="Frag ClaudeMC... (Enter zum Senden, Shift+Enter für neue Zeile)"
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
