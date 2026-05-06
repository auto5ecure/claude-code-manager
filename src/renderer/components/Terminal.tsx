import { useEffect, useRef, useCallback, useState } from 'react';
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
  alreadySpawned?: boolean; // SSH tabs: PTY already spawned by main process
}

interface TerminalProps {
  tabs: Tab[];
  activeTabId: string | null;
  isVisible: boolean;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
}

// Wraps fitAddon.fit() and preserves the user's scroll position.
// Without this, fit() resets the viewport to the bottom whenever rows change,
// making it impossible to stay scrolled up while data streams in another tab.
function safeFit(fitAddon: FitAddon, xterm: XTerm): void {
  const buffer = xterm.buffer.active;
  const distFromBottom = buffer.length - buffer.viewportY - xterm.rows;
  // Use a 2-line tolerance: during rapid streaming, buffer.length can grow
  // faster than xterm updates viewportY, causing distFromBottom to read 1-2
  // even when the user is actually following the output at the bottom.
  // Without this tolerance, safeFit incorrectly treats those cases as
  // "user scrolled up" and pins the viewport just before the bottom —
  // which then disables xterm's auto-scroll indefinitely.
  const wasAtBottom = distFromBottom <= 2;

  fitAddon.fit();

  if (wasAtBottom) {
    // Explicitly jump to bottom so xterm resumes auto-scroll on new data.
    // fit() alone doesn't guarantee this when rows change mid-stream.
    xterm.scrollToBottom();
  } else {
    // User was scrolled up: restore position so they stay on the same content
    const newLength = xterm.buffer.active.length;
    const targetLine = Math.max(0, newLength - xterm.rows - distFromBottom);
    xterm.scrollToLine(targetLine);
  }
}

export default function Terminal({ tabs, activeTabId, isVisible, onCloseTab, onSelectTab }: TerminalProps) {
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const xtermsRef = useRef<Map<string, XTerm>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const initializedRef = useRef<Set<string>>(new Set());
  const spawnedRef = useRef<Set<string>>(new Set());
  const webglAddonsRef = useRef<Map<string, WebglAddon>>(new Map());
  // Keep a ref to tabs so initializeTab can access current tab data without stale closure
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

  // Scroll-to-bottom button: shown when active tab is not at the bottom
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // Stable ref so onScroll handlers inside initializeTab always see the current activeTabId
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;

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
      scrollback: 5000,
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#7c3aed',
        selectionBackground: '#ffffff66',
        selectionForeground: '#18181b',
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
        webglAddonsRef.current.delete(tab.id);
      });
      xterm.loadAddon(webglAddon);
      webglAddonsRef.current.set(tab.id, webglAddon);
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

    // Track scroll position so we can show/hide the scroll-to-bottom button
    xterm.onScroll(() => {
      if (activeTabIdRef.current !== tab.id) return;
      const buf = xterm.buffer.active;
      const dist = buf.length - buf.viewportY - xterm.rows;
      setIsScrolledUp(dist > 2);
    });

    // Fit and spawn PTY asynchronously so the DOM has settled before measuring
    const tabId = tab.id;
    setTimeout(() => {
      if (spawnedRef.current.has(tabId)) return;
      spawnedRef.current.add(tabId);

      safeFit(fitAddon, xterm);
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (!tab.alreadySpawned) {
        window.electronAPI?.ptySpawn(tabId, tab.projectPath, cols, rows, tab.runClaude, tab.unleashed);
      }
      // Second fit after layout settling — ensures correct cols if first fit ran before layout
      setTimeout(() => safeFit(fitAddon, xterm), 300);
    }, 100);

    // Resize observer — debounced to avoid feedback loops during layout thrashing
    // Guard: skip fit() when container is hidden (display:none → size 0).
    // Without this guard, switching tabs causes fit() to compute {cols:2, rows:1},
    // which sends an invalid ptyResize to the PTY → program reformats for 2-col width
    // → IPC flood → UI hangs and scroll breaks on the active tab.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { safeFit(fitAddon, xterm); resizeTimer = null; }, 32);
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
        const fa = fitAddonsRef.current.get(activeTabId);
        const xt = xtermsRef.current.get(activeTabId);
        if (fa && xt) safeFit(fa, xt);
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

    // Fit on tab switch — double rAF ensures layout is settled before measuring.
    // Also read the scroll position of the newly-active tab to sync the button.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fa = fitAddonsRef.current.get(activeTabId);
        const xt = xtermsRef.current.get(activeTabId);
        if (fa && xt) {
          safeFit(fa, xt);
          const buf = xt.buffer.active;
          const dist = buf.length - buf.viewportY - xt.rows;
          setIsScrolledUp(dist > 2);
        }
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
        const fa = fitAddonsRef.current.get(activeTabId);
        const xt = xtermsRef.current.get(activeTabId);
        if (fa && xt) safeFit(fa, xt);
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
        // Dispose WebGL addon first to avoid onRequestRedraw crash during xterm.dispose()
        try { webglAddonsRef.current.get(tabId)?.dispose(); } catch { /* ignore WebGL cleanup errors */ }
        webglAddonsRef.current.delete(tabId);
        try { xtermsRef.current.get(tabId)?.dispose(); } catch { /* ignore */ }
        xtermsRef.current.delete(tabId);
        fitAddonsRef.current.delete(tabId);
        initializedRef.current.delete(tabId);
        spawnedRef.current.delete(tabId);
      }
    });
  }, [tabs]);

  const handleScrollToBottom = useCallback(() => {
    if (!activeTabId) return;
    const xt = xtermsRef.current.get(activeTabId);
    if (xt) {
      xt.scrollToBottom();
      setIsScrolledUp(false);
    }
  }, [activeTabId]);

  // Drag-and-Drop: files from Finder → POSIX shell-quoted paths into the PTY.
  // Mirrors macOS Terminal.app / iTerm2 behavior. Quotes only when needed.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, tabId: string) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
      .map((p) => (/[\s"'`$\\()]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p))
      .join(' ');
    if (paths) {
      window.electronAPI?.ptyWrite(tabId, paths);
      // Refocus the terminal so the user can immediately keep typing
      xtermsRef.current.get(tabId)?.focus();
    }
  }, []);

  if (tabs.length === 0) {
    return null;
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
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, tab.id)}
          />
        ))}
        {isScrolledUp && (
          <button
            className="terminal-scroll-btn"
            onClick={handleScrollToBottom}
            title="Zum Ende scrollen"
          >
            ↓
          </button>
        )}
      </div>
    </main>
  );
}
