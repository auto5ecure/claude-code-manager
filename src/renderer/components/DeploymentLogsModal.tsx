import { useState, useEffect, useRef } from 'react';
import type { DeploymentConfig } from '../../shared/types';

interface DeploymentLogsModalProps {
  config: DeploymentConfig;
  onClose: () => void;
}

export default function DeploymentLogsModal({ config, onClose }: DeploymentLogsModalProps) {
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState(100);
  const logsRef = useRef<HTMLPreElement>(null);

  async function loadLogs() {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getDeploymentLogs(config, lines);
      if (result?.success) {
        setLogs(result.logs || '');
      } else {
        setError(result?.error || 'Logs konnten nicht geladen werden');
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadLogs();
  }, [config, lines]);

  useEffect(() => {
    // Scroll to bottom when logs change
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="deployment-modal-overlay" onClick={onClose}>
      <div className="deployment-modal deployment-logs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="deployment-modal-header">
          <span>Logs: {config.name}</span>
          <button className="deployment-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="deployment-logs-toolbar">
          <select
            value={lines}
            onChange={(e) => setLines(Number(e.target.value))}
            className="logs-lines-select"
          >
            <option value={50}>Letzte 50 Zeilen</option>
            <option value={100}>Letzte 100 Zeilen</option>
            <option value={500}>Letzte 500 Zeilen</option>
            <option value={1000}>Letzte 1000 Zeilen</option>
          </select>
          <button className="btn-refresh-logs" onClick={loadLogs} disabled={loading}>
            {loading ? 'Lade...' : '↻ Aktualisieren'}
          </button>
        </div>

        <div className="deployment-logs-content">
          {loading && !logs && (
            <div className="logs-loading">
              <div className="spinner"></div>
              <span>Lade Logs...</span>
            </div>
          )}

          {error && (
            <div className="logs-error">
              <span className="error-icon">✗</span>
              <span>{error}</span>
            </div>
          )}

          {logs && (
            <pre ref={logsRef} className="logs-output">
              {logs}
            </pre>
          )}

          {!loading && !error && !logs && (
            <div className="logs-empty">
              Keine Logs verfügbar
            </div>
          )}
        </div>

        <div className="deployment-modal-footer">
          <button className="btn-close" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
