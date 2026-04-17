import { useState, useEffect, useRef } from 'react';
import type { Agent, ServerCredential } from '../../shared/types';
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
}

interface AgentsTabProps {
  projects: Project[];
  coworkRepos: CoworkRepo[];
  onInjectAgentResult?: (agentId: string, output: string, projectName: string) => void;
}

function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function StateBadge({ state }: { state: Agent['state'] }) {
  const labels: Record<Agent['state'], string> = {
    pending: 'Ausstehend',
    running: 'Läuft',
    done: 'Fertig',
    error: 'Fehler',
  };
  return (
    <span className={`agent-state-badge agent-state-${state}`}>
      {state === 'running' ? '⚡' : state === 'done' ? '✓' : state === 'error' ? '✗' : '·'} {labels[state]}
    </span>
  );
}

export default function AgentsTab({ projects, coworkRepos, onInjectAgentResult }: AgentsTabProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');
  const [task, setTask] = useState('');
  const [creating, setCreating] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const [servers, setServers] = useState<ServerCredential[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>('');

  const allProjectOptions: { path: string; name: string; label: string }[] = [
    ...projects.map(p => ({ path: p.path, name: p.name, label: `[Proj] ${p.name}` })),
    ...coworkRepos.map(r => ({ path: r.localPath, name: r.name, label: `[Cowork] ${r.name}` })),
  ];

  // Set default project path when options load
  useEffect(() => {
    if (!selectedProjectPath && allProjectOptions.length > 0) {
      setSelectedProjectPath(allProjectOptions[0].path);
    }
  }, [projects, coworkRepos]);

  // Load servers filtered by selected project
  useEffect(() => {
    const projectOption = allProjectOptions.find(p => p.path === selectedProjectPath);
    const projectId = projectOption?.path.replace(/\//g, '-');
    window.electronAPI?.getServers(projectId).then(list => {
      setServers(list || []);
      setSelectedServerId('');
    }).catch(() => setServers([]));
  }, [selectedProjectPath]);

  async function loadAgents() {
    try {
      const list = await window.electronAPI?.listAgents();
      if (list) setAgents(list);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadAgents();

    const unsubChunk = window.electronAPI?.onAgentChunk((data) => {
      const { agentId, text, done, error } = data;
      setAgents(prev => prev.map(a => {
        if (a.id !== agentId) return a;
        if (done) {
          return {
            ...a,
            state: error ? 'error' : 'done',
            error: error,
          };
        }
        if (text) {
          return { ...a, output: a.output + text };
        }
        return a;
      }));
    });

    const unsubList = window.electronAPI?.onAgentListUpdated(() => {
      loadAgents();
    });

    return () => {
      unsubChunk?.();
      unsubList?.();
    };
  }, []);

  const selectedAgent = agents.find(a => a.id === selectedAgentId) || null;

  // Auto-scroll output – debounced to avoid hundreds of reflows during streaming
  useEffect(() => {
    const timer = setTimeout(() => {
      outputEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }, 80);
    return () => clearTimeout(timer);
  }, [selectedAgent?.output]);

  async function handleCreateAgent() {
    if (!selectedProjectPath || !task.trim() || creating) return;
    setCreating(true);
    startLoading('Agent wird gestartet...');
    const agentId = generateAgentId();
    const projectOption = allProjectOptions.find(p => p.path === selectedProjectPath);
    const projectName = projectOption?.name || selectedProjectPath.split('/').pop() || 'Unbekannt';

    // Append server context if selected
    const selectedServer = servers.find(s => s.id === selectedServerId);
    const serverContext = selectedServer
      ? `\n\n[Server-Kontext: ${selectedServer.name} — ssh ${selectedServer.user}@${selectedServer.host}${selectedServer.port !== 22 ? ` -p ${selectedServer.port}` : ''}${selectedServer.sshKeyPath ? ` -i ${selectedServer.sshKeyPath}` : ''}]`
      : '';

    // Optimistic add
    const optimisticAgent: Agent = {
      id: agentId,
      projectPath: selectedProjectPath,
      projectName,
      task: task.trim() + serverContext,
      state: 'running',
      output: '',
      createdAt: new Date().toISOString(),
    };
    setAgents(prev => [optimisticAgent, ...prev]);
    setSelectedAgentId(agentId);
    setTask('');

    try {
      const result = await window.electronAPI?.createAgent(agentId, selectedProjectPath, optimisticAgent.task);
      if (!result?.success) {
        setAgents(prev => prev.map(a => a.id === agentId ? { ...a, state: 'error', error: result?.error || 'Fehler' } : a));
      }
    } catch (err) {
      setAgents(prev => prev.map(a => a.id === agentId ? { ...a, state: 'error', error: (err as Error).message } : a));
    } finally {
      setCreating(false);
      stopLoading();
    }
  }

  async function handleStopAgent(agentId: string) {
    await window.electronAPI?.stopAgent(agentId);
  }

  async function handleClearAgent(agentId: string) {
    await window.electronAPI?.clearAgent(agentId);
    setAgents(prev => prev.filter(a => a.id !== agentId));
    if (selectedAgentId === agentId) setSelectedAgentId(null);
  }

  async function handleClearAll() {
    await window.electronAPI?.clearAllAgents();
    setAgents(prev => prev.filter(a => a.state === 'running' || a.state === 'pending'));
    if (selectedAgent && (selectedAgent.state === 'done' || selectedAgent.state === 'error')) {
      setSelectedAgentId(null);
    }
  }

  function handleInject(agent: Agent) {
    onInjectAgentResult?.(agent.id, agent.output, agent.projectName);
  }

  const activeCount = agents.filter(a => a.state === 'running' || a.state === 'pending').length;

  return (
    <div className="agents-tab">
      <div className="agents-header">
        <span className="agents-title">
          Sub-Agents
          {activeCount > 0 && <span className="agents-count-badge">{activeCount}</span>}
        </span>
        {agents.some(a => a.state === 'done' || a.state === 'error') && (
          <button className="orch-btn-small" onClick={handleClearAll}>
            Abgeschlossene entfernen
          </button>
        )}
      </div>

      <div className="agents-body">
        {/* Left panel */}
        <div className="agents-list-panel">
          <div className="agent-create-form">
            <select
              className="agent-project-select"
              value={selectedProjectPath}
              onChange={e => setSelectedProjectPath(e.target.value)}
            >
              {allProjectOptions.map(opt => (
                <option key={opt.path} value={opt.path}>{opt.label}</option>
              ))}
              {allProjectOptions.length === 0 && (
                <option value="">Keine Projekte</option>
              )}
            </select>
            {servers.length > 0 && (
              <select
                className="agent-project-select"
                value={selectedServerId}
                onChange={e => setSelectedServerId(e.target.value)}
                title="Server (optional)"
              >
                <option value="">🖥 Kein Server</option>
                {servers.map(s => (
                  <option key={s.id} value={s.id}>🖥 {s.name} ({s.user}@{s.host})</option>
                ))}
              </select>
            )}
            <textarea
              className="agent-task-input"
              placeholder="Aufgabe beschreiben..."
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={3}
              onKeyDown={e => {
                if (e.key === 'Enter' && e.metaKey) handleCreateAgent();
              }}
            />
            <button
              className="agent-create-btn"
              onClick={handleCreateAgent}
              disabled={!selectedProjectPath || !task.trim() || creating}
            >
              {creating ? 'Startet...' : '+ Agent starten'}
            </button>
          </div>

          <div className="agent-list">
            {agents.length === 0 && (
              <div className="agents-empty">Noch keine Agents gestartet</div>
            )}
            {agents.map(agent => (
              <div
                key={agent.id}
                className={`agent-list-item${selectedAgentId === agent.id ? ' selected' : ''}`}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <StateBadge state={agent.state} />
                <div className="agent-item-name">{agent.projectName}</div>
                <div className="agent-item-task">{agent.task.slice(0, 60)}{agent.task.length > 60 ? '…' : ''}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="agents-output-panel">
          {!selectedAgent ? (
            <div className="agents-output-empty">
              <p>Agent auswählen um Output zu sehen</p>
            </div>
          ) : (
            <>
              <div className="agents-output-header">
                <div className="agents-output-info">
                  <StateBadge state={selectedAgent.state} />
                  <strong>{selectedAgent.projectName}</strong>
                  <span className="agents-output-path">{selectedAgent.projectPath}</span>
                </div>
                <div className="agents-output-task">Aufgabe: {selectedAgent.task}</div>
              </div>

              <div className="agents-output-content">
                <pre className="agents-output-text">
                  {selectedAgent.output || '(Kein Output)'}
                  {selectedAgent.state === 'running' && <span className="streaming-cursor" />}
                </pre>
                {selectedAgent.error && (
                  <div className="agents-output-error">Fehler: {selectedAgent.error}</div>
                )}
                <div ref={outputEndRef} />
              </div>

              <div className="agents-output-actions">
                {selectedAgent.state === 'running' && (
                  <button className="btn-danger" onClick={() => handleStopAgent(selectedAgent.id)}>
                    Stoppen
                  </button>
                )}
                {(selectedAgent.state === 'done' || selectedAgent.state === 'error') && selectedAgent.output && (
                  <button className="btn-accent" onClick={() => handleInject(selectedAgent)}>
                    → ClaudeMC
                  </button>
                )}
                {selectedAgent.state !== 'running' && (
                  <button className="orch-btn-small" onClick={() => handleClearAgent(selectedAgent.id)}>
                    Entfernen
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
