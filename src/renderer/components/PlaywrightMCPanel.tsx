import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaywrightInstallStatus, PlaywrightScript, PlaywrightBrowserState, TaskServerConnection } from '../../shared/types';

interface ProjectTarget {
  path: string;
  name: string;
  type: 'project' | 'cowork';
}

type Tab = 'browser' | 'recorder' | 'scripts';

interface LogLine {
  ts: number;
  channel: 'stdout' | 'stderr' | 'exit' | 'info';
  text: string;
}

const DEFAULT_SCRIPT = `// Playwright script — wird mit Electron-Node + bundled Playwright ausgeführt.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log('Title:', await page.title());
  await page.screenshot({ path: 'example.png' });
  await browser.close();
})();
`;

export default function PlaywrightMCPanel() {
  const [tab, setTab] = useState<Tab>('browser');
  const [install, setInstall] = useState<PlaywrightInstallStatus | null>(null);
  const [browserState, setBrowserState] = useState<PlaywrightBrowserState>({ isOpen: false });
  const [busy, setBusy] = useState<string | null>(null);

  // Browser tab
  const [url, setUrl] = useState('https://example.com');
  const [evalCode, setEvalCode] = useState('return document.title;');
  const [evalResult, setEvalResult] = useState<string>('');
  const [htmlPreview, setHtmlPreview] = useState<string>('');

  // Recorder tab
  const [recUrl, setRecUrl] = useState('https://example.com');
  const [recName, setRecName] = useState('');
  const [activeRecorderRunId, setActiveRecorderRunId] = useState<string | null>(null);

  // Scripts tab
  const [scripts, setScripts] = useState<PlaywrightScript[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptCode, setScriptCode] = useState(DEFAULT_SCRIPT);
  const [scriptName, setScriptName] = useState('');
  const [activeScriptRunId, setActiveScriptRunId] = useState<string | null>(null);

  // Log buffer keyed by runId (so we can render the active one)
  const [logs, setLogs] = useState<Map<string, LogLine[]>>(new Map());
  const logEndRef = useRef<HTMLDivElement>(null);

  // Save-as-project-task modal
  const [saveTaskModal, setSaveTaskModal] = useState<{ targets: ProjectTarget[]; servers: TaskServerConnection[] } | null>(null);
  const [saveTaskTarget, setSaveTaskTarget] = useState<string>('');
  const [saveTaskName, setSaveTaskName] = useState('');
  const [saveTaskDesc, setSaveTaskDesc] = useState('');
  const [saveTaskServerHint, setSaveTaskServerHint] = useState('');

  // --- bootstrap ---------------------------------------------------------
  const refreshAll = useCallback(async () => {
    const status = await window.electronAPI?.playwrightInstallStatus();
    if (status) setInstall(status);
    const state = await window.electronAPI?.playwrightBrowserState();
    if (state) setBrowserState(state);
    const list = await window.electronAPI?.playwrightListScripts();
    if (list) setScripts(list);
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Live output stream
  useEffect(() => {
    const off = window.electronAPI?.onPlaywrightOutput((data) => {
      setLogs(prev => {
        const next = new Map(prev);
        const lines = next.get(data.runId) ?? [];
        if (data.channel === 'exit') {
          lines.push({ ts: Date.now(), channel: 'exit', text: `\n[exit ${data.payload}]\n` });
          // Stop tracking that run as active
          setActiveRecorderRunId(curr => curr === data.runId ? null : curr);
          setActiveScriptRunId(curr => curr === data.runId ? null : curr);
          // After exit refresh scripts (codegen may have created one) + install status
          setTimeout(() => refreshAll(), 200);
        } else {
          lines.push({ ts: Date.now(), channel: data.channel, text: String(data.payload) });
        }
        next.set(data.runId, lines);
        return next;
      });
      // Auto-scroll
      setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
    });
    return () => { off?.(); };
  }, [refreshAll]);

  // Poll browser state while a browser is open
  useEffect(() => {
    if (tab !== 'browser') return;
    const t = setInterval(async () => {
      const state = await window.electronAPI?.playwrightBrowserState();
      if (state) setBrowserState(state);
    }, 1500);
    return () => clearInterval(t);
  }, [tab]);

  // --- handlers ----------------------------------------------------------
  async function handleInstallChromium() {
    setBusy('install');
    const res = await window.electronAPI?.playwrightInstallChromium();
    if (!res?.success) {
      alert('Install fehlgeschlagen: ' + (res?.error || 'unbekannt'));
      setBusy(null);
      return;
    }
    setActiveScriptRunId(res.runId!); // reuse field as "active log to show"
  }

  async function handleOpen() {
    setBusy('open');
    const res = await window.electronAPI?.playwrightOpenBrowser(url);
    setBusy(null);
    if (!res?.success) alert('Open fehlgeschlagen: ' + (res?.error || 'unbekannt'));
    const state = await window.electronAPI?.playwrightBrowserState();
    if (state) setBrowserState(state);
  }

  async function handleClose() {
    setBusy('close');
    await window.electronAPI?.playwrightCloseBrowser();
    setBusy(null);
    setBrowserState({ isOpen: false });
  }

  async function handleScreenshot() {
    setBusy('screenshot');
    const res = await window.electronAPI?.playwrightScreenshot();
    setBusy(null);
    if (res?.success && res.path) {
      // Show in OS file manager
      window.open?.(`file://${res.path}`);
      alert('Screenshot gespeichert: ' + res.path);
    } else {
      alert('Screenshot fehlgeschlagen: ' + (res?.error || 'unbekannt'));
    }
  }

  async function handlePdf() {
    setBusy('pdf');
    const res = await window.electronAPI?.playwrightPdf();
    setBusy(null);
    if (res?.success && res.path) {
      alert('PDF gespeichert: ' + res.path);
    } else {
      alert('PDF fehlgeschlagen: ' + (res?.error || 'unbekannt'));
    }
  }

  async function handleHtml() {
    setBusy('html');
    const res = await window.electronAPI?.playwrightDumpHtml();
    setBusy(null);
    if (res?.success && res.html) {
      setHtmlPreview(res.html.slice(0, 50000)); // cap to avoid React death
    } else {
      alert('HTML-Dump fehlgeschlagen: ' + (res?.error || 'unbekannt'));
    }
  }

  async function handleEval() {
    setBusy('eval');
    const res = await window.electronAPI?.playwrightEval(evalCode);
    setBusy(null);
    if (res?.success) {
      setEvalResult(JSON.stringify(res.result, null, 2));
    } else {
      setEvalResult('Fehler: ' + (res?.error || 'unbekannt'));
    }
  }

  async function handleStartCodegen() {
    if (!recName.trim()) { alert('Bitte Script-Name angeben'); return; }
    setBusy('codegen');
    const res = await window.electronAPI?.playwrightStartCodegen({ url: recUrl, scriptName: recName });
    setBusy(null);
    if (!res?.success) { alert('Codegen-Start fehlgeschlagen: ' + (res?.error || 'unbekannt')); return; }
    setActiveRecorderRunId(res.runId!);
  }

  async function handleStopCodegen() {
    if (!activeRecorderRunId) return;
    await window.electronAPI?.playwrightKillRun(activeRecorderRunId);
  }

  async function handleNewScript() {
    setSelectedScriptId(null);
    setScriptCode(DEFAULT_SCRIPT);
    setScriptName('');
  }

  async function handleSaveScript() {
    if (!scriptName.trim()) { alert('Bitte Name angeben'); return; }
    const saved = await window.electronAPI?.playwrightSaveScript({
      id: selectedScriptId ?? undefined,
      name: scriptName,
      code: scriptCode,
    });
    if (saved) setSelectedScriptId(saved.id);
    refreshAll();
  }

  async function handleLoadScript(id: string) {
    const res = await window.electronAPI?.playwrightGetScript(id);
    if (!res) return;
    setSelectedScriptId(id);
    setScriptCode(res.code);
    setScriptName(res.script.name);
  }

  async function handleRunScript(id: string) {
    const res = await window.electronAPI?.playwrightRunScript(id);
    if (!res?.success) { alert('Run fehlgeschlagen: ' + (res?.error || 'unbekannt')); return; }
    setActiveScriptRunId(res.runId!);
  }

  async function handleKillScript() {
    if (!activeScriptRunId) return;
    await window.electronAPI?.playwrightKillRun(activeScriptRunId);
  }

  async function handleOpenSaveAsTask() {
    if (!scriptCode.trim()) { alert('Erst Script schreiben'); return; }
    const [projects, coworks, servers] = await Promise.all([
      window.electronAPI?.getProjects(),
      window.electronAPI?.getCoworkRepositories(),
      window.electronAPI?.getTaskServers(),
    ]);
    const targets: ProjectTarget[] = [
      ...(projects ?? []).map(p => ({ path: p.path, name: p.name, type: 'project' as const })),
      ...(coworks ?? []).map(r => ({ path: r.localPath, name: r.name, type: 'cowork' as const })),
    ];
    if (targets.length === 0) { alert('Keine Projekte/Cowork-Repos registriert'); return; }
    setSaveTaskModal({ targets, servers: servers ?? [] });
    setSaveTaskTarget(targets[0].path);
    setSaveTaskName(scriptName || 'playwright-task');
    setSaveTaskDesc('');
    setSaveTaskServerHint('');
  }

  async function handleConfirmSaveAsTask() {
    if (!saveTaskModal || !saveTaskTarget || !saveTaskName.trim()) return;
    const res = await window.electronAPI?.playwrightSaveAsProjectTask({
      projectPath: saveTaskTarget,
      taskName: saveTaskName,
      code: scriptCode,
      description: saveTaskDesc || undefined,
      serverHint: saveTaskServerHint || undefined,
    });
    if (!res?.success) {
      alert('Speichern fehlgeschlagen: ' + (res?.error || 'unbekannt'));
      return;
    }
    setSaveTaskModal(null);
    alert(`Als Task gespeichert: ${res.filePath}\n\nIm RTaskMC-Tab erscheint er nach „↻ Tasks neu scannen".`);
  }

  async function handleDeleteScript(id: string) {
    if (!confirm('Script wirklich löschen?')) return;
    await window.electronAPI?.playwrightDeleteScript(id);
    if (selectedScriptId === id) {
      setSelectedScriptId(null);
      setScriptCode(DEFAULT_SCRIPT);
      setScriptName('');
    }
    refreshAll();
  }

  // --- render ------------------------------------------------------------
  const activeRunId = tab === 'recorder' ? activeRecorderRunId : activeScriptRunId;
  const activeLog = activeRunId ? logs.get(activeRunId) ?? [] : [];

  return (
    <div className="playwrightmc-panel">
      <div className="playwrightmc-header">
        <div>
          <h2>🎭 PlaywrightMC</h2>
          <p className="muted">Browser orchestrieren, Scripts laufen lassen, Aktionen aufzeichnen.</p>
        </div>
        <div className="playwrightmc-install">
          {install ? (
            <>
              <span className={`badge ${install.playwrightInstalled ? 'ok' : 'err'}`}>
                Playwright {install.playwrightVersion ?? '–'}
              </span>
              <span className={`badge ${install.chromiumInstalled ? 'ok' : 'warn'}`}>
                Chromium {install.chromiumInstalled ? '✓' : '✗'}
              </span>
              {!install.chromiumInstalled && (
                <button className="btn small" onClick={handleInstallChromium} disabled={busy === 'install'}>
                  Chromium installieren
                </button>
              )}
            </>
          ) : <span className="muted">prüfe …</span>}
        </div>
      </div>

      <div className="playwrightmc-tabs">
        <button className={tab === 'browser' ? 'active' : ''} onClick={() => setTab('browser')}>Browser</button>
        <button className={tab === 'recorder' ? 'active' : ''} onClick={() => setTab('recorder')}>Recorder</button>
        <button className={tab === 'scripts' ? 'active' : ''} onClick={() => setTab('scripts')}>Scripts ({scripts.length})</button>
      </div>

      {tab === 'browser' && (
        <div className="playwrightmc-tab-content">
          <div className="row">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="url-input"
            />
            {!browserState.isOpen ? (
              <button className="btn primary" onClick={handleOpen} disabled={busy === 'open'}>
                {busy === 'open' ? 'Öffne …' : 'Öffnen'}
              </button>
            ) : (
              <>
                <button className="btn" onClick={handleOpen} disabled={busy === 'open'}>Goto</button>
                <button className="btn danger" onClick={handleClose}>Schließen</button>
              </>
            )}
          </div>

          {browserState.isOpen && (
            <div className="browser-state-row">
              <span className="muted">aktuell:</span>
              <span className="mono">{browserState.currentUrl}</span>
              <span className="muted">·</span>
              <span>{browserState.title}</span>
            </div>
          )}

          <div className="action-grid">
            <button className="btn" onClick={handleScreenshot} disabled={!browserState.isOpen || !!busy}>📸 Screenshot</button>
            <button className="btn" onClick={handlePdf} disabled={!browserState.isOpen || !!busy}>📄 PDF</button>
            <button className="btn" onClick={handleHtml} disabled={!browserState.isOpen || !!busy}>🧾 HTML-Dump</button>
          </div>

          <div className="eval-block">
            <label>JS evaluieren (async, return = Wert):</label>
            <textarea
              value={evalCode}
              onChange={(e) => setEvalCode(e.target.value)}
              rows={3}
              className="code-input"
            />
            <button className="btn" onClick={handleEval} disabled={!browserState.isOpen || !!busy}>
              {busy === 'eval' ? 'Werte aus …' : 'Evaluate'}
            </button>
            {evalResult && (
              <pre className="eval-result">{evalResult}</pre>
            )}
          </div>

          {htmlPreview && (
            <details className="html-preview">
              <summary>HTML-Dump ({htmlPreview.length.toLocaleString()} chars{htmlPreview.length === 50000 ? ', gekürzt' : ''})</summary>
              <pre>{htmlPreview}</pre>
            </details>
          )}
        </div>
      )}

      {tab === 'recorder' && (
        <div className="playwrightmc-tab-content">
          <p className="muted">
            Öffnet Chromium + den Playwright-Inspector. Klicks/Eingaben werden zu JS-Code.
            Beim Schließen des Inspectors landet das Script in der Scripts-Liste.
          </p>
          <div className="row">
            <input
              type="text"
              value={recUrl}
              onChange={(e) => setRecUrl(e.target.value)}
              placeholder="Start-URL"
              className="url-input"
              disabled={!!activeRecorderRunId}
            />
            <input
              type="text"
              value={recName}
              onChange={(e) => setRecName(e.target.value)}
              placeholder="Script-Name (z.B. login-flow)"
              className="name-input"
              disabled={!!activeRecorderRunId}
            />
            {!activeRecorderRunId ? (
              <button className="btn primary" onClick={handleStartCodegen} disabled={busy === 'codegen' || !install?.chromiumInstalled}>
                🔴 Aufnahme starten
              </button>
            ) : (
              <button className="btn danger" onClick={handleStopCodegen}>
                ⏹ Aufnahme beenden
              </button>
            )}
          </div>

          <div className="log-block">
            <div className="log-block-header">
              <span>Codegen-Output {activeRecorderRunId ? '(läuft)' : ''}</span>
            </div>
            <pre className="log-block-body">
              {activeLog.length === 0 ? (
                <span className="muted">Output erscheint hier sobald Codegen läuft.</span>
              ) : activeLog.map((l, i) => (
                <span key={i} className={`log-${l.channel}`}>{l.text}</span>
              ))}
              <div ref={logEndRef} />
            </pre>
          </div>
        </div>
      )}

      {saveTaskModal && (
        <div className="playwrightmc-modal-backdrop" onClick={() => setSaveTaskModal(null)}>
          <div className="playwrightmc-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Als Projekt-Task speichern</h3>
            <p className="muted">Schreibt das aktuelle Script nach <code>&lt;projekt&gt;/tasks/&lt;name&gt;.js</code>. Im RTaskMC erscheint es dann nach „↻ Tasks neu scannen" und kann remote ausgeführt + cron-geplant werden.</p>
            <label>
              <span>Projekt</span>
              <select value={saveTaskTarget} onChange={(e) => setSaveTaskTarget(e.target.value)}>
                {saveTaskModal.targets.map(t => (
                  <option key={t.path} value={t.path}>{t.type === 'cowork' ? '🔗 ' : '📁 '}{t.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Task-Name (ohne .js)</span>
              <input
                type="text"
                value={saveTaskName}
                onChange={(e) => setSaveTaskName(e.target.value)}
                placeholder="z.B. login-flow"
              />
            </label>
            <label>
              <span>Beschreibung (optional)</span>
              <input
                type="text"
                value={saveTaskDesc}
                onChange={(e) => setSaveTaskDesc(e.target.value)}
                placeholder="Wird als // @desc:-Frontmatter geschrieben"
              />
            </label>
            <label>
              <span>Server-Hint (optional)</span>
              {saveTaskModal.servers.length > 0 ? (
                <select value={saveTaskServerHint} onChange={(e) => setSaveTaskServerHint(e.target.value)}>
                  <option value="">— kein Hint —</option>
                  {saveTaskModal.servers.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={saveTaskServerHint}
                  onChange={(e) => setSaveTaskServerHint(e.target.value)}
                  placeholder="Name eines RTask-Servers"
                />
              )}
            </label>
            <div className="playwrightmc-modal-actions">
              <button className="btn" onClick={() => setSaveTaskModal(null)}>Abbrechen</button>
              <button className="btn primary" onClick={handleConfirmSaveAsTask}>Speichern</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'scripts' && (
        <div className="playwrightmc-tab-content scripts-layout">
          <div className="scripts-list">
            <button className="btn small" onClick={handleNewScript}>+ Neues Script</button>
            {scripts.length === 0 ? (
              <p className="muted small">Noch keine Scripts. Lege eins an oder nimm eins per Recorder auf.</p>
            ) : scripts.map(s => (
              <div
                key={s.id}
                className={`script-row ${selectedScriptId === s.id ? 'selected' : ''}`}
                onClick={() => handleLoadScript(s.id)}
              >
                <div className="script-row-main">
                  <strong>{s.name}</strong>
                  <span className="muted small">{s.filename}</span>
                </div>
                <div className="script-row-meta">
                  {s.lastRunAt && (
                    <span className={`badge small ${s.lastRunExitCode === 0 ? 'ok' : 'err'}`}>
                      {s.lastRunExitCode === 0 ? '✓' : '✗'} {new Date(s.lastRunAt).toLocaleString('de-DE')}
                    </span>
                  )}
                  <button className="btn small primary" onClick={(e) => { e.stopPropagation(); handleRunScript(s.id); }}>▶ Run</button>
                  <button className="btn small danger" onClick={(e) => { e.stopPropagation(); handleDeleteScript(s.id); }}>🗑</button>
                </div>
              </div>
            ))}
          </div>

          <div className="scripts-editor">
            <div className="row">
              <input
                type="text"
                value={scriptName}
                onChange={(e) => setScriptName(e.target.value)}
                placeholder="Script-Name"
                className="name-input"
              />
              <button className="btn primary" onClick={handleSaveScript}>💾 Speichern</button>
              <button className="btn" onClick={handleOpenSaveAsTask} title="Als tasks/&lt;name&gt;.js in ein Projekt schreiben — kann dann via RTaskMC remote ausgeführt + cron-geplant werden">📂 Als Projekt-Task</button>
              {activeScriptRunId && (
                <button className="btn danger" onClick={handleKillScript}>⏹ Stop</button>
              )}
            </div>
            <textarea
              value={scriptCode}
              onChange={(e) => setScriptCode(e.target.value)}
              className="code-editor"
              spellCheck={false}
            />
            <div className="log-block">
              <div className="log-block-header">
                <span>Output {activeScriptRunId ? '(läuft)' : ''}</span>
              </div>
              <pre className="log-block-body">
                {activeLog.length === 0 ? (
                  <span className="muted">Output erscheint hier sobald ein Script läuft.</span>
                ) : activeLog.map((l, i) => (
                  <span key={i} className={`log-${l.channel}`}>{l.text}</span>
                ))}
                <div ref={logEndRef} />
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
