import { useEffect, useState } from 'react';
import type { Project } from './App';
import type { CoworkRepository } from '../../shared/types';
import type { NavView } from './NavSidebar';

interface HomeViewProps {
  projects: Project[];
  coworkRepos: CoworkRepository[];
  tabCount: number;
  activeAgentCount: number;
  onNavigate: (view: NavView) => void;
  onOpenClaude: (project: Project) => void;
}

const GREETINGS = [
  'Was wollen wir heute bauen?',
  'Bereit für eine neue Session.',
  'Womit kann Claude helfen?',
  'Starte deine nächste Idee.',
  'Code, Commit, Repeat.',
];

interface LogEntry {
  id: string;
  type: string;
  project?: string;
  message?: string;
  timestamp: string;
}

export default function HomeView({
  projects,
  coworkRepos,
  tabCount,
  activeAgentCount,
  onNavigate,
  onOpenClaude,
}: HomeViewProps) {
  const greeting = GREETINGS[new Date().getDate() % GREETINGS.length];
  const [recentLog, setRecentLog] = useState<LogEntry[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  useEffect(() => {
    window.electronAPI?.getLog?.().then((entries) => {
      if (entries && Array.isArray(entries)) {
        setRecentLog(entries.slice(0, 5));
      }
    }).catch(() => {});
  }, []);

  function formatTime(ts: string) {
    try {
      return new Date(ts).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return ts;
    }
  }

  function handleStartClaude() {
    const proj = projects.find(p => p.id === selectedProject) || projects[0];
    if (proj) {
      onOpenClaude(proj);
    }
  }

  const stats = [
    { label: 'Projekte', value: projects.length, nav: 'projects' as NavView },
    { label: 'Offene Terminals', value: tabCount, nav: 'terminal' as NavView },
    { label: 'Aktive Agents', value: activeAgentCount, nav: 'agents' as NavView },
    { label: 'Cowork-Repos', value: coworkRepos.length, nav: 'cowork' as NavView },
  ];

  return (
    <div className="home-view">
      <div className="home-greeting">
        <h1>{greeting}</h1>
        <p className="home-subtitle">Claude Code Manager</p>
      </div>

      {/* Stats */}
      <div className="home-stats-grid">
        {stats.map((stat) => (
          <button
            key={stat.label}
            className="stats-card"
            onClick={() => onNavigate(stat.nav)}
          >
            <span className="stats-value">{stat.value}</span>
            <span className="stats-label">{stat.label}</span>
          </button>
        ))}
      </div>

      {/* Quick actions */}
      <div className="home-section">
        <h2 className="home-section-title">Schnellstart</h2>
        <div className="home-quick-actions">
          <div className="quick-action-row">
            <select
              className="quick-project-select"
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
            >
              <option value="">Projekt wählen...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              className="quick-action-btn primary"
              onClick={handleStartClaude}
              disabled={projects.length === 0}
            >
              ▶ Claude starten
            </button>
          </div>
          <div className="quick-action-row">
            <button className="quick-action-btn" onClick={() => onNavigate('terminal')}>
              ⌘ Terminal
            </button>
            <button className="quick-action-btn" onClick={() => onNavigate('agents')}>
              🤖 Sub-Agent
            </button>
            <button className="quick-action-btn" onClick={() => onNavigate('orchestrator')}>
              🧠 Orchestrator
            </button>
          </div>
        </div>
      </div>

      {/* Recent sessions */}
      {recentLog.length > 0 && (
        <div className="home-section">
          <h2 className="home-section-title">Letzte Aktivitäten</h2>
          <div className="home-recent-list">
            {recentLog.map((entry) => (
              <div key={entry.id} className="home-recent-item">
                <span className="recent-project">{entry.project || '–'}</span>
                <span className="recent-message">{entry.message || entry.type}</span>
                <span className="recent-time">{formatTime(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
