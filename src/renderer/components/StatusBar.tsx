import type { Project } from './App';

interface StatusBarProps {
  appVersion: string;
  activeProject: Project | null;
  claudeCodeStatus: {
    installed: boolean;
    version?: string;
  } | null;
  whatsAppStatus: {
    connected: boolean;
    ready: boolean;
    phoneNumber?: string;
  };
  updateInfo: {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    latestVersion?: string;
    error?: string;
  };
  globalStatus: string | null;
  onShowWhatsApp: () => void;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
}

export default function StatusBar({
  appVersion,
  activeProject,
  claudeCodeStatus,
  whatsAppStatus,
  updateInfo,
  globalStatus,
  onShowWhatsApp,
  onCheckForUpdates,
  onInstallUpdate,
}: StatusBarProps) {
  return (
    <div className="status-bar">
      {/* Left: copyright + project path */}
      <div className="status-bar-left">
        <span className="status-copyright">© Timon Esser</span>
        {activeProject ? (
          <span className="status-project" title={activeProject.path}>
            📁 {activeProject.path}
          </span>
        ) : (
          <span className="status-project muted">Kein Projekt ausgewählt</span>
        )}
      </div>

      {/* Center: claude status */}
      <div className="status-bar-center">
        {claudeCodeStatus && (
          <span
            className={`status-claude ${claudeCodeStatus.installed ? 'ok' : 'err'}`}
            title={claudeCodeStatus.installed ? `Claude Code ${claudeCodeStatus.version || ''}` : 'Claude Code fehlt'}
          >
            <span className="status-dot" />
            claude
          </span>
        )}
        {globalStatus && (
          <span className="status-global">
            <span className="status-spinner-sm" />
            {globalStatus}
          </span>
        )}
      </div>

      {/* Right: WhatsApp + version + updates */}
      <div className="status-bar-right">
        <button
          className={`status-whatsapp ${whatsAppStatus.ready ? 'connected' : ''}`}
          onClick={onShowWhatsApp}
          title={whatsAppStatus.ready ? `WhatsApp: +${whatsAppStatus.phoneNumber}` : 'WhatsApp verbinden'}
        >
          💬
        </button>

        <span className="status-version">v{appVersion}</span>

        {updateInfo.checking && (
          <span className="status-update-checking">Prüfe...</span>
        )}
        {updateInfo.downloading && (
          <span className="status-update-downloading">
            {Math.round(updateInfo.progress)}%
          </span>
        )}
        {!updateInfo.checking && !updateInfo.downloading && updateInfo.available && (
          <button className="status-update-btn available" onClick={onInstallUpdate}>
            ↑ v{updateInfo.latestVersion}
          </button>
        )}
        {!updateInfo.checking && !updateInfo.downloading && !updateInfo.available && (
          <button className="status-update-btn" onClick={onCheckForUpdates}>
            ↻
          </button>
        )}
        {updateInfo.error && (
          <span className="status-update-error" title={updateInfo.error}>⚠</span>
        )}
      </div>
    </div>
  );
}
