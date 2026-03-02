import { useState, useEffect } from 'react';

interface LogEntry {
  timestamp: string;
  type: 'command' | 'activity' | 'error';
  project?: string;
  message: string;
}

interface LogViewerProps {
  projectFilter?: string;
  onClose: () => void;
}

export default function LogViewer({ projectFilter, onClose }: LogViewerProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'command' | 'activity' | 'error'>('all');

  useEffect(() => {
    loadLog();
  }, [projectFilter]);

  async function loadLog() {
    setLoading(true);
    const log = await window.electronAPI?.getLog(200, projectFilter);
    setEntries(log || []);
    setLoading(false);
  }

  async function handleClear() {
    if (confirm('Log wirklich löschen?')) {
      await window.electronAPI?.clearLog();
      setEntries([]);
    }
  }

  const filteredEntries = entries.filter(
    (e) => filter === 'all' || e.type === filter
  );

  function formatTime(timestamp: string) {
    const date = new Date(timestamp);
    return date.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getTypeIcon(type: LogEntry['type']) {
    switch (type) {
      case 'command': return '⚡';
      case 'activity': return '📋';
      case 'error': return '❌';
    }
  }

  function getTypeClass(type: LogEntry['type']) {
    switch (type) {
      case 'command': return 'log-command';
      case 'activity': return 'log-activity';
      case 'error': return 'log-error';
    }
  }

  return (
    <div className="log-overlay" onClick={onClose}>
      <div className="log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="log-header">
          <div className="log-title">
            <span>Activity Log</span>
            {projectFilter && <span className="log-project-filter">{projectFilter}</span>}
          </div>
          <div className="log-header-actions">
            <button className="log-clear-btn" onClick={handleClear}>Löschen</button>
            <button className="log-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="log-filters">
          <button
            className={`log-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            Alle
          </button>
          <button
            className={`log-filter-btn ${filter === 'command' ? 'active' : ''}`}
            onClick={() => setFilter('command')}
          >
            ⚡ Commands
          </button>
          <button
            className={`log-filter-btn ${filter === 'activity' ? 'active' : ''}`}
            onClick={() => setFilter('activity')}
          >
            📋 Aktivität
          </button>
          <button
            className={`log-filter-btn ${filter === 'error' ? 'active' : ''}`}
            onClick={() => setFilter('error')}
          >
            ❌ Fehler
          </button>
        </div>
        <div className="log-content">
          {loading ? (
            <div className="log-loading">Lade...</div>
          ) : filteredEntries.length === 0 ? (
            <div className="log-empty">Keine Einträge</div>
          ) : (
            <div className="log-entries">
              {filteredEntries.map((entry, index) => (
                <div key={index} className={`log-entry ${getTypeClass(entry.type)}`}>
                  <span className="log-entry-icon">{getTypeIcon(entry.type)}</span>
                  <span className="log-entry-time">{formatTime(entry.timestamp)}</span>
                  {entry.project && !projectFilter && (
                    <span className="log-entry-project">{entry.project}</span>
                  )}
                  <span className="log-entry-message">{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
