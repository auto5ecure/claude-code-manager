import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebglAddon } from 'xterm-addon-webgl';
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
  isVisible: boolean;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
}

export default function Terminal({ tabs, activeTabId, isVisible, onCloseTab, onSelectTab }: TerminalProps) {
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const xtermsRef = useRef<Map<string, XTerm>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const initializedRef = useRef<Set<string>>(new Set());
  const spawnedRef = useRef<Set<string>>(new Set());
  // Keep a ref to tabs so initializeTab can access current tab data without stale closure
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

  const setContainerRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(tabId, el);
    } else {
      containerRefs.current.delete(tabId);
    }
  }, []);

  // Initialize a single terminal tab (called lazily when tab first becomes active)
  const initializeTab = useCallback((tab: Tab) => {
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

    // WebGL renderer for GPU-accelerated rendering — significantly reduces
    // WindowServer pressure vs canvas renderer during heavy Claude streaming output
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // Context loss (e.g. GPU reset) — dispose WebGL, fall back to canvas renderer
        webglAddon.dispose();
      });
      xterm.loadAddon(webglAddon);
    } catch {
      // WebGL not available in this environment, canvas renderer stays active
    }

    xtermsRef.current.set(tab.id, xterm);
    fitAddonsRef.current.set(tab.id, fitAddon);
    initializedRef.current.add(tab.id);

    // Handle Cmd+V for image paste
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'v' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        (async () => {
          const imageData = await window.electronAPI?.getClipboardImage();
          if (imageData) {
            const savedPath = await window.electronAPI?.saveScreenshot(tab.projectPath, imageData);
            if (savedPath) {
              window.electronAPI?.ptyWrite(tab.id, savedPath);
            }
          } else {
            const text = await navigator.clipboard.readText();
            if (text) {
              window.electronAPI?.ptyWrite(tab.id, text);
            }
          }
        })();
        return false;
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

    // Fit and spawn PTY asynchronously so the DOM has settled before measuring
    const tabId = tab.id;
    setTimeout(() => {
      if (spawnedRef.current.has(tabId)) return;
      spawnedRef.current.add(tabId);

      fitAddon.fit();
      const cols = xterm.cols;
      const rows = xterm.rows;
      window.electronAPI?.ptySpawn(tabId, tab.projectPath, cols, rows, tab.runClaude, tab.unleashed);
      // Second fit after layout settling — ensures correct cols if first fit ran before layout
      setTimeout(() => fitAddon.fit(), 300);
    }, 100);

    // Resize observer — debounced to avoid feedback loops during layout thrashing
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { fitAddon.fit(); resizeTimer = null; }, 32);
    });
    resizeObserver.observe(container);
    resizeObserversRef.current.set(tab.id, resizeObserver);
  }, []);

  // Re-fit when the terminal panel becomes visible (navView switch back to terminal)
  // Uses two rAF passes so the browser has painted the new layout before measuring
  useEffect(() => {
    if (!isVisible || !activeTabId) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddonsRef.current.get(activeTabId)?.fit();
      });
    });
  }, [isVisible, activeTabId]);

  // Lazy init: initialize a tab only when it first becomes active
  // This avoids creating N xterm instances + spawning N PTYs simultaneously on load
  useEffect(() => {
    if (!activeTabId) return;

    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (tab && !initializedRef.current.has(tab.id)) {
      // Defer slightly so the container div is in the DOM and has its final size
      setTimeout(() => initializeTab(tab), 0);
    }

    // Fit on tab switch — double rAF ensures layout is settled before measuring
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddonsRef.current.get(activeTabId)?.fit();
      });
    });
  }, [activeTabId, initializeTab]);

  // Listen for PTY data and exit events
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

  // Cleanup when tabs are closed
  useEffect(() => {
    const currentTabIds = new Set(tabs.map((t) => t.id));

    initializedRef.current.forEach((tabId) => {
      if (!currentTabIds.has(tabId)) {
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
