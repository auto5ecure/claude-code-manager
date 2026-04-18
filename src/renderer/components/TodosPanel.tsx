import { useState, useEffect } from 'react';
import type { Todo } from '../../shared/types';
import type { NavView } from './NavSidebar';

interface Project {
  id: string;
  path: string;
  name: string;
}

interface TodosPanelProps {
  projects: Project[];
  onSetNavView: (view: NavView) => void;
}

type FilterType = 'all' | 'open' | 'done' | 'delegated';

export default function TodosPanel({ projects, onSetNavView }: TodosPanelProps) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<FilterType>('open');
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showDescInput, setShowDescInput] = useState(false);
  const [delegatingId, setDelegatingId] = useState<string | null>(null);
  const [delegateProjectPath, setDelegateProjectPath] = useState('');
  const [delegating, setDelegating] = useState(false);

  useEffect(() => {
    loadTodos();
    const unsub = window.electronAPI?.onTodosUpdated?.(() => loadTodos());
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (projects.length > 0 && !delegateProjectPath) {
      setDelegateProjectPath(projects[0].path);
    }
  }, [projects]);

  async function loadTodos() {
    try {
      const list = await window.electronAPI?.getTodos?.();
      if (list) setTodos(list);
    } catch { /* ignore */ }
  }

  async function handleAdd() {
    const title = newTitle.trim();
    if (!title) return;
    const todo = await window.electronAPI?.addTodo?.({ title, description: newDesc.trim() || undefined });
    if (todo) {
      setTodos(prev => [todo, ...prev]);
      setNewTitle('');
      setNewDesc('');
      setShowDescInput(false);
    }
  }

  async function handleToggleComplete(todo: Todo) {
    const updates: Partial<Todo> = {
      completed: !todo.completed,
      completedAt: !todo.completed ? new Date().toISOString() : undefined,
    };
    const updated = await window.electronAPI?.updateTodo?.(todo.id, updates);
    if (updated) setTodos(prev => prev.map(t => t.id === todo.id ? updated : t));
  }

  async function handleDelete(id: string) {
    await window.electronAPI?.deleteTodo?.(id);
    setTodos(prev => prev.filter(t => t.id !== id));
    if (delegatingId === id) setDelegatingId(null);
  }

  async function handleDelegate(todo: Todo) {
    if (!delegateProjectPath || delegating) return;
    setDelegating(true);
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const task = todo.description
      ? `${todo.title}\n\n${todo.description}`
      : todo.title;
    try {
      const result = await window.electronAPI?.createAgent?.(agentId, delegateProjectPath, task);
      if (result?.success) {
        const updates: Partial<Todo> = {
          delegatedAgentId: agentId,
          delegatedAt: new Date().toISOString(),
        };
        const updated = await window.electronAPI?.updateTodo?.(todo.id, updates);
        if (updated) setTodos(prev => prev.map(t => t.id === todo.id ? updated : t));
        setDelegatingId(null);
        onSetNavView('agents');
      }
    } finally {
      setDelegating(false);
    }
  }

  function filteredTodos(): Todo[] {
    switch (filter) {
      case 'open': return todos.filter(t => !t.completed && !t.delegatedAgentId);
      case 'done': return todos.filter(t => t.completed);
      case 'delegated': return todos.filter(t => !!t.delegatedAgentId && !t.completed);
      default: return todos;
    }
  }

  const openCount = todos.filter(t => !t.completed && !t.delegatedAgentId).length;
  const doneCount = todos.filter(t => t.completed).length;
  const delegatedCount = todos.filter(t => !!t.delegatedAgentId && !t.completed).length;

  const visible = filteredTodos();

  return (
    <div className="todos-panel">
      <div className="todos-header">
        <span className="todos-title">Todos</span>
        <div className="todos-filter-tabs">
          {(['all', 'open', 'done', 'delegated'] as FilterType[]).map(f => (
            <button
              key={f}
              className={`todos-filter-btn${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? `Alle (${todos.length})` :
               f === 'open' ? `Offen (${openCount})` :
               f === 'done' ? `Erledigt (${doneCount})` :
               `Delegiert (${delegatedCount})`}
            </button>
          ))}
        </div>
      </div>

      <div className="todos-add-form">
        <div className="todos-add-row">
          <input
            className="todos-add-input"
            placeholder="Neue Aufgabe..."
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); }
              if (e.key === 'ArrowDown') setShowDescInput(true);
            }}
            onFocus={() => setShowDescInput(true)}
          />
          <button className="todos-add-btn" onClick={handleAdd} disabled={!newTitle.trim()}>+</button>
        </div>
        {showDescInput && (
          <textarea
            className="todos-add-desc"
            placeholder="Beschreibung (optional)..."
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            rows={2}
            onKeyDown={e => {
              if (e.key === 'Enter' && e.metaKey) handleAdd();
            }}
          />
        )}
      </div>

      <div className="todos-list">
        {visible.length === 0 && (
          <div className="todos-empty">
            {filter === 'open' ? 'Keine offenen Todos' :
             filter === 'done' ? 'Noch nichts erledigt' :
             filter === 'delegated' ? 'Keine delegierten Todos' :
             'Keine Todos vorhanden'}
          </div>
        )}
        {visible.map(todo => (
          <div key={todo.id} className={`todo-item${todo.completed ? ' completed' : ''}${todo.delegatedAgentId ? ' delegated' : ''}`}>
            <button
              className="todo-checkbox"
              onClick={() => handleToggleComplete(todo)}
              title={todo.completed ? 'Als offen markieren' : 'Als erledigt markieren'}
            >
              {todo.completed ? '☑' : todo.delegatedAgentId ? '⚡' : '☐'}
            </button>
            <div className="todo-content">
              <span className="todo-title">{todo.title}</span>
              {todo.description && <span className="todo-desc-text">{todo.description}</span>}
              {todo.delegatedAgentId && !todo.completed && (
                <div className="todo-delegated-info">
                  <span className="todo-delegated-label">⚡ Läuft als Agent</span>
                  <button
                    className="todo-jump-btn"
                    onClick={() => onSetNavView('agents')}
                  >
                    Zu Agent springen →
                  </button>
                </div>
              )}
              {delegatingId === todo.id && (
                <div className="todo-delegate-panel">
                  <select
                    className="todo-delegate-select"
                    value={delegateProjectPath}
                    onChange={e => setDelegateProjectPath(e.target.value)}
                  >
                    {projects.map(p => (
                      <option key={p.path} value={p.path}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    className="todo-delegate-start-btn"
                    onClick={() => handleDelegate(todo)}
                    disabled={delegating || !delegateProjectPath}
                  >
                    {delegating ? 'Startet...' : 'Starten'}
                  </button>
                  <button
                    className="todo-delegate-cancel-btn"
                    onClick={() => setDelegatingId(null)}
                  >
                    Abbrechen
                  </button>
                </div>
              )}
            </div>
            <div className="todo-actions">
              {!todo.completed && !todo.delegatedAgentId && delegatingId !== todo.id && (
                <button
                  className="todo-action-btn todo-delegate-btn"
                  onClick={() => setDelegatingId(todo.id)}
                  title="Als Sub-Agent delegieren"
                >
                  →🤖
                </button>
              )}
              <button
                className="todo-action-btn todo-delete-btn"
                onClick={() => handleDelete(todo.id)}
                title="Löschen"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
