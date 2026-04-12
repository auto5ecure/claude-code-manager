import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

export interface Tab {
  id: string;
  projectPath: string;
  projectName: string;
  runClaude: boolean;
  unleashed?: boolean;
}

interface TerminalProps {
  tabs: Tab[];
  activeTabId: string | null;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
}

export default function Terminal({ tabs, activeTabId, onCloseTab, onSelectTab }: TerminalProps) {
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const xtermsRef = useRef<Map<string, XTerm>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const initializedRef = useRef<Set<string>>(new Set());
  const spawnedRef = useRef<Set<string>>(new Set());

  const setContainerRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(tabId, el);
    } else {
      containerRefs.current.delete(tabId);
    }
  }, []);

  // Initialize terminal for a tab
  useEffect(() => {
    tabs.forEach((tab) => {
      if (initializedRef.current.has(tab.id)) return;

      const container = containerRefs.current.get(tab.id);
      if (!container) return;

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
      xterm.open(container);

      xtermsRef.current.set(tab.id, xterm);
      fitAddonsRef.current.set(tab.id, fitAddon);
      initializedRef.current.add(tab.id);

      // Handle Cmd+V for image paste
      xterm.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'v' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          // Handle paste ourselves
          (async () => {
            const imageData = await window.electronAPI?.getClipboardImage();
            if (imageData) {
              // Image found - save and insert path
              const savedPath = await window.electronAPI?.saveScreenshot(tab.projectPath, imageData);
              if (savedPath) {
                window.electronAPI?.ptyWrite(tab.id, savedPath);
              }
            } else {
              // No image - paste text from clipboard
              const text = await navigator.clipboard.readText();
              if (text) {
                window.electronAPI?.ptyWrite(tab.id, text);
              }
            }
          })();
          return false; // Prevent xterm default handling
        }
        return true;
      });

      // Handle input
      xterm.onData((data) => {
        window.electronAPI?.ptyWrite(tab.id, data);
      });

      xterm.onResize(({ cols, rows }) => {
        window.electronAPI?.ptyResize(tab.id, cols, rows);
      });

      // Fit terminal and THEN spawn PTY with correct size (only once!)
      const tabId = tab.id;
      setTimeout(() => {
        if (spawnedRef.current.has(tabId)) return; // Prevent double spawn
        spawnedRef.current.add(tabId);

        fitAddon.fit();
        const cols = xterm.cols;
        const rows = xterm.rows;
        // Spawn PTY with actual terminal size
        window.electronAPI?.ptySpawn(tabId, tab.projectPath, cols, rows, tab.runClaude, tab.unleashed);
      }, 100);

      // Handle container resize (store reference for cleanup)
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(container);
      resizeObserversRef.current.set(tab.id, resizeObserver);
    });
  }, [tabs]);

  // Listen for PTY data
  useEffect(() => {
    const handleData = (tabId: string, data: string) => {
      xtermsRef.current.get(tabId)?.write(data);
    };

    const handleExit = (tabId: string, code: number) => {
      xtermsRef.current.get(tabId)?.writeln(`\r\n[Process exited with code ${code}]`);
    };

    const unsubData = window.electronAPI?.onPtyData(handleData);
    const unsubExit = window.electronAPI?.onPtyExit(handleExit);

    return () => {
      unsubData?.();
      unsubExit?.();
    };
  }, []);

  // Fit terminal when tab becomes active
  useEffect(() => {
    if (activeTabId) {
      setTimeout(() => {
        fitAddonsRef.current.get(activeTabId)?.fit();
      }, 50);
    }
  }, [activeTabId]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (activeTabId) {
        fitAddonsRef.current.get(activeTabId)?.fit();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTabId]);

  // Cleanup closed tabs
  useEffect(() => {
    const currentTabIds = new Set(tabs.map((t) => t.id));

    initializedRef.current.forEach((tabId) => {
      if (!currentTabIds.has(tabId)) {
        // Disconnect ResizeObserver
        resizeObserversRef.current.get(tabId)?.disconnect();
        resizeObserversRef.current.delete(tabId);

        window.electronAPI?.ptyKill(tabId);
        xtermsRef.current.get(tabId)?.dispose();
        xtermsRef.current.delete(tabId);
        fitAddonsRef.current.delete(tabId);
        initializedRef.current.delete(tabId);
        spawnedRef.current.delete(tabId);
      }
    });
  }, [tabs]);

  if (tabs.length === 0) {
    return (
      <main className="terminal-container">
        <div className="terminal-empty">
          <p>Klicke auf ▶ oder ⌘ um ein Terminal zu öffnen</p>
        </div>
      </main>
    );
  }

  return (
    <main className="terminal-container">
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
          >
            <span className="tab-name">{tab.projectName}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="terminals-wrapper">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-panel ${activeTabId === tab.id ? 'active' : ''}`}
            ref={(el) => setContainerRef(tab.id, el)}
          />
        ))}
      </div>
    </main>
  );
}
