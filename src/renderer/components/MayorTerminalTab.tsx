import { useState, useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const MAYOR_TAB_ID = 'mayor-terminal';

interface MayorTerminalTabProps {
  gastownInstalled: boolean;
  isActive: boolean;
}

interface SettingsProject {
  id: string;
  name: string;
  path: string;
  type: 'tools' | 'projekt' | 'cowork';
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

export default function MayorTerminalTab({ gastownInstalled, isActive }: MayorTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const spawnedRef = useRef(false);

  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProjects, setSettingsProjects] = useState<SettingsProject[]>([]);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState<SettingsProject | null>(null);

  // Initialize xterm on mount
  useEffect(() => {
    if (!gastownInstalled || !containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#7c3aed',
        selectionBackground: '#7c3aed44',
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    xterm.onData((data) => {
      window.electronAPI?.ptyWrite(MAYOR_TAB_ID, data);
    });

    xterm.onResize(({ cols, rows }) => {
      window.electronAPI?.ptyResize(MAYOR_TAB_ID, cols, rows);
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && containerRef.current.offsetParent !== null) {
        fitAddon.fit();
      }
    });
    resizeObserver.observe(containerRef.current);

    // Spawn PTY after xterm is ready
    setTimeout(() => {
      if (spawnedRef.current) return;
      spawnedRef.current = true;
      fitAddon.fit();
      const { cols, rows } = xterm;
      spawnMayorPty(cols, rows);
    }, 150);

    return () => {
      resizeObserver.disconnect();
    };
  }, [gastownInstalled]);

  // Refit when Mayor tab becomes visible
  useEffect(() => {
    if (isActive && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    }
  }, [isActive]);

  // Listen to PTY data/exit events
  useEffect(() => {
    const unsubData = window.electronAPI?.onPtyData((tabId, data) => {
      if (tabId === MAYOR_TAB_ID) {
        xtermRef.current?.write(data);
      }
    });

    const unsubExit = window.electronAPI?.onPtyExit((tabId, code) => {
      if (tabId === MAYOR_TAB_ID) {
        xtermRef.current?.writeln(`\r\n[Mayor session beendet (code ${code})]`);
        spawnedRef.current = false;
        setConnectError(`Session beendet. Klick zum Neuverbinden.`);
      }
    });

    return () => {
      unsubData?.();
      unsubExit?.();
    };
  }, []);

  async function spawnMayorPty(cols: number, rows: number) {
    setConnecting(true);
    setConnectError(null);
    const result = await window.electronAPI?.mayorPtySpawn?.(cols, rows);
    setConnecting(false);
    if (!result?.success) {
      setConnectError(result?.error || 'Verbindung zu Mayor fehlgeschlagen');
      xtermRef.current?.writeln(`\r\n[Fehler: ${result?.error || 'Mayor nicht erreichbar'}]`);
      xtermRef.current?.writeln('[Stelle sicher dass Gastown läuft: gt start]');
    }
  }

  async function reconnect() {
    if (!fitAddonRef.current || !xtermRef.current) return;
    spawnedRef.current = true;
    setConnectError(null);
    fitAddonRef.current.fit();
    await spawnMayorPty(xtermRef.current.cols, xtermRef.current.rows);
  }

  // ── Settings ──────────────────────────────────────────────

  async function openSettings() {
    setShowSettings(true);
    setLoadingSettings(true);
    try {
      const [projects, coworkRepos] = await Promise.all([
        window.electronAPI?.getProjects() || [],
        window.electronAPI?.getCoworkRepositories() || [],
      ]);

      const toItem = async (id: string, name: string, path: string, type: SettingsProject['type']): Promise<SettingsProject> => {
        let isRig = false;
        let rigName: string | undefined;
        try {
          const status = await window.electronAPI?.getRigStatus?.(path);
          isRig = status?.isRig ?? false;
          rigName = status?.rigName;
        } catch { /* ignore */ }
        return { id, name, path, type, isRig, rigName, prefix: autoPrefix(name), subscribing: false };
      };

      const items = [
        ...await Promise.all(projects.map(p => toItem(p.id, p.name, p.path, p.type))),
        ...await Promise.all(coworkRepos.map(r => toItem(r.id, r.name, r.localPath, 'cowork'))),
      ];
      setSettingsProjects(items);
    } catch (err) {
      console.error('Failed to load settings:', err);
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

    setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: true, error: undefined } : p));

    try {
      const rigName = project.name.replace(/-/g, '_');
      const result = await window.electronAPI?.addRig?.(project.path, rigName, project.prefix);
      if (result?.success) {
        setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, isRig: true, rigName, subscribing: false } : p));
      } else {
        setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p));
      }
    } catch (err) {
      setSettingsProjects(prev => prev.map(p => p.id === id ? { ...p, subscribing: false, error: (err as Error).message } : p));
    }
  }

  async function unsubscribeProject(project: SettingsProject) {
    setConfirmUnsubscribe(null);
    const rigName = project.rigName || project.name.replace(/-/g, '_');

    setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: true, error: undefined } : p));

    try {
      const result = await window.electronAPI?.removeRig?.(rigName);
      if (result?.success) {
        setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, isRig: false, rigName: undefined, subscribing: false } : p));
      } else {
        setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: result?.error || 'Fehler' } : p));
      }
    } catch (err) {
      setSettingsProjects(prev => prev.map(p => p.id === project.id ? { ...p, subscribing: false, error: (err as Error).message } : p));
    }
  }

  // ── Render ────────────────────────────────────────────────

  if (!gastownInstalled) {
    return (
      <div className="mayor-tab mayor-not-installed">
        <div className="mayor-install-prompt">
          <h3>Mayor Terminal</h3>
          <p>Gastown ist nicht installiert.</p>
          <p className="install-hint">
            Installiere Gastown: <code>brew install gastown</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mayor-tab">
      {/* Header */}
      <div className="mayor-header">
        <h2>Mayor</h2>
        {connecting && <span className="mayor-acp-status disconnected">Verbinde…</span>}
        {connectError && !connecting && (
          <button className="mayor-reconnect-btn" onClick={reconnect} title="Mayor-Session neu verbinden">
            ↻ Neuverbinden
          </button>
        )}
        <button className="mayor-settings-btn" onClick={openSettings} title="Projekte als Rigs verwalten">
          ⚙
        </button>
      </div>

      {/* Settings overlay */}
      {showSettings && (
        <div className="mayor-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="mayor-settings-panel" onClick={e => e.stopPropagation()}>
            <div className="mayor-settings-header">
              <h3>Projekte als Rigs verwalten</h3>
              <button className="mayor-settings-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="mayor-settings-body">
              {loadingSettings ? (
                <div className="mayor-settings-loading">Lade Projekte...</div>
              ) : settingsProjects.length === 0 ? (
                <div className="mayor-settings-empty">Keine Projekte gefunden.</div>
              ) : (
                <div className="mayor-settings-list">
                  {(['tools', 'projekt', 'cowork'] as const).map(groupType => {
                    const group = settingsProjects.filter(p => p.type === groupType);
                    if (group.length === 0) return null;
                    const label = groupType === 'cowork' ? 'Cowork' : groupType === 'tools' ? 'Tools' : 'Projekte';
                    return (
                      <div key={groupType}>
                        <div className="mayor-settings-group-label">{label}</div>
                        {group.map(project => (
                          <div key={project.id} className={`mayor-settings-row ${project.isRig ? 'is-rig' : ''}`}>
                            <span className={`mayor-settings-dot ${project.isRig ? 'active' : ''}`}>
                              {project.subscribing ? '…' : project.isRig ? '●' : '○'}
                            </span>
                            <span className="mayor-settings-row-name">{project.name}</span>
                            {project.isRig ? (
                              <>
                                {project.rigName && <span className="mayor-settings-row-tag">{project.rigName}</span>}
                                <button
                                  className="mayor-settings-unsub-btn"
                                  onClick={() => setConfirmUnsubscribe(project)}
                                  disabled={project.subscribing}
                                  title="Rig entfernen"
                                >−</button>
                              </>
                            ) : (
                              <>
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
                                  className="mayor-settings-sub-btn"
                                  onClick={() => subscribeProject(project.id)}
                                  disabled={project.subscribing || !project.prefix}
                                >
                                  {project.subscribing ? '…' : '+'}
                                </button>
                              </>
                            )}
                            {project.error && <span className="mayor-settings-row-error" title={project.error}>!</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm unsubscribe */}
      {confirmUnsubscribe && (
        <div className="mayor-confirm-overlay" onClick={() => setConfirmUnsubscribe(null)}>
          <div className="mayor-confirm-modal" onClick={e => e.stopPropagation()}>
            <h4>Rig entfernen?</h4>
            <p><strong>{confirmUnsubscribe.rigName || confirmUnsubscribe.name}</strong> aus Gastown entfernen? Dies löscht den Symlink und die Registrierung.</p>
            <div className="mayor-confirm-actions">
              <button className="mayor-confirm-cancel" onClick={() => setConfirmUnsubscribe(null)}>Abbrechen</button>
              <button className="mayor-confirm-remove" onClick={() => unsubscribeProject(confirmUnsubscribe)}>Entfernen</button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal */}
      <div className="mayor-terminal-wrapper" ref={containerRef} />
    </div>
  );
}
