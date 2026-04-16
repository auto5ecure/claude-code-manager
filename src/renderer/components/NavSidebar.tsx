import {
  House,
  SquareTerminal,
  FolderOpen,
  GitBranch,
  Bot,
  Cpu,
  BookOpen,
  Mail,
  Server,
  Sun,
  Moon,
  Settings,
} from 'lucide-react';
import { useTheme } from '../ThemeContext';

export type NavView = 'home' | 'terminal' | 'projects' | 'cowork' | 'agents' | 'orchestrator' | 'wiki' | 'emailmc' | 'servermc';

interface NavSidebarProps {
  navView: NavView;
  setNavView: (view: NavView) => void;
  tabCount: number;
  projectCount: number;
  coworkCount: number;
  activeAgentCount: number;
  onShowSettings?: () => void;
}

interface NavItemDef {
  id: NavView;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

export default function NavSidebar({
  navView,
  setNavView,
  tabCount,
  projectCount,
  coworkCount,
  activeAgentCount,
  onShowSettings,
}: NavSidebarProps) {
  const { theme, toggleTheme } = useTheme();

  const items: NavItemDef[] = [
    { id: 'home', icon: <House size={18} />, label: 'Home' },
    { id: 'terminal', icon: <SquareTerminal size={18} />, label: 'Terminal', badge: tabCount > 0 ? tabCount : undefined },
    { id: 'projects', icon: <FolderOpen size={18} />, label: 'Projekte', badge: projectCount > 0 ? projectCount : undefined },
    { id: 'cowork', icon: <GitBranch size={18} />, label: 'Cowork', badge: coworkCount > 0 ? coworkCount : undefined },
    { id: 'agents', icon: <Bot size={18} />, label: 'Agents', badge: activeAgentCount > 0 ? activeAgentCount : undefined },
    { id: 'orchestrator', icon: <Cpu size={18} />, label: 'ClaudeMC' },
    { id: 'wiki', icon: <BookOpen size={18} />, label: 'Wiki' },
    { id: 'emailmc', icon: <Mail size={18} />, label: 'EmailMC' },
    { id: 'servermc', icon: <Server size={18} />, label: 'ServerMC' },
  ];

  return (
    <aside className="nav-sidebar">
      {/* Header */}
      <div className="nav-sidebar-header">
        <div className="nav-logo">
          <span className="nav-logo-icon">⚡</span>
          <span className="nav-logo-name">Claude MC</span>
        </div>
      </div>

      {/* Nav items */}
      <nav className="nav-items">
        {items.map((item, idx) => (
          <button
            key={item.id}
            className={`nav-item ${navView === item.id ? 'active' : ''}`}
            onClick={() => setNavView(item.id)}
            style={{ '--stagger-delay': `${idx * 40}ms` } as React.CSSProperties}
            title={item.label}
          >
            <span className="nav-item-icon">{item.icon}</span>
            <span className="nav-item-label">{item.label}</span>
            {item.badge !== undefined && (
              <span className="nav-item-badge">{item.badge}</span>
            )}
          </button>
        ))}
      </nav>

      {/* Bottom actions */}
      <div className="nav-sidebar-bottom">
        <button
          className="nav-item nav-item-bottom"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          <span className="nav-item-icon">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </span>
          <span className="nav-item-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        {onShowSettings && (
          <button
            className="nav-item nav-item-bottom"
            onClick={onShowSettings}
            title="Einstellungen"
          >
            <span className="nav-item-icon"><Settings size={18} /></span>
            <span className="nav-item-label">Settings</span>
          </button>
        )}
      </div>
    </aside>
  );
}
