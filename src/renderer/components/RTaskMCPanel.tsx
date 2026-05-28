import { useEffect, useRef, useState, useCallback } from 'react';
import type { TaskJob, TaskJobStatus, TaskArtifact, ProjectTask, TaskServerConnection, TaskSchedule } from '../../shared/types';

type TaskSource = 'project' | 'adhoc';

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'Jede Minute',      expr: '* * * * *' },
  { label: 'Stündlich (:00)',  expr: '0 * * * *' },
  { label: 'Täglich 03:00',    expr: '0 3 * * *' },
  { label: 'Mo–Fr 09:00',      expr: '0 9 * * 1-5' },
  { label: 'Wöchentlich So 00:00', expr: '0 0 * * 0' },
  { label: 'Monatlich 1. um 00:00', expr: '0 0 1 * *' },
];

function statusClass(s: TaskJobStatus): string {
  switch (s) {
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'killed': return 'killed';
    default: return 'queued';
  }
}

function statusIcon(s: TaskJobStatus): string {
  switch (s) {
    case 'running': return '▶';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'killed': return '■';
    default: return '…';
  }
}

export default function RTaskMCPanel() {
  const [servers, setServers] = useState<TaskServerConnection[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<TaskJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [scriptDraft, setScriptDraft] = useState('echo "hello from task-server"\ndate');
  const [scriptName, setScriptName] = useState('');
  const [running, setRunning] = useState(false);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [downloadingArtifact, setDownloadingArtifact] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<TaskSchedule[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState<{ job: TaskJob } | null>(null);
  const [taskSource, setTaskSource] = useState<TaskSource>('project');
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<ProjectTask | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const streamIdRef = useRef<string | null>(null);
  const stopChunkListenerRef = useRef<(() => void) | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Single-server model: auto-pick the first registered server. Refresh periodically
  // so that a server added in Settings becomes available without re-mounting the panel.
  const loadServers = useCallback(async () => {
    const list = await window.electronAPI?.getTaskServers();
    setServers(list || []);
    if (list && list.length > 0) {
      // Always sync selection to the first (and presumably only) server
      if (!selectedServerId || !list.some(s => s.id === selectedServerId)) {
        setSelectedServerId(list[0].id);
      }
    } else {
      setSelectedServerId(null);
    }
  }, [selectedServerId]);

  const refreshJobs = useCallback(async (serverId: string) => {
    const res = await window.electronAPI?.taskServerListJobs(serverId);
    if (Array.isArray(res)) setJobs(res);
    else setJobs([]);
  }, []);

  const refreshSchedules = useCallback(async (serverId: string) => {
    const res = await window.electronAPI?.taskServerListSchedules(serverId);
    if (Array.isArray(res)) setSchedules(res);
    else setSchedules([]);
  }, []);

  useEffect(() => {
    loadServers();
    // Re-poll so that adding a server in SettingsModal becomes visible here
    const t = window.setInterval(loadServers, 5000);
    return () => window.clearInterval(t);
  }, [loadServers]);

  const loadProjectTasks = useCallback(async () => {
    setLoadingTasks(true);
    try {
      // First: re-sync the RTaskMC skill section in each project's CLAUDE.md
      // so Claude (any flavor) knows about new/changed tasks
      await window.electronAPI?.syncAllClaudemdTasksSections().catch(() => null);
      const tasks = await window.electronAPI?.scanProjectTasks();
      setProjectTasks(tasks || []);
      // Auto-expand all projects that have tasks
      const projectsWithTasks = new Set((tasks || []).map(t => t.projectPath));
      setExpandedProjects(projectsWithTasks);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  useEffect(() => { loadProjectTasks(); }, [loadProjectTasks]);

  // Group project-tasks by projectPath
  const tasksByProject = projectTasks.reduce<Record<string, { name: string; type: 'project' | 'cowork'; tasks: ProjectTask[] }>>((acc, t) => {
    if (!acc[t.projectPath]) acc[t.projectPath] = { name: t.projectName, type: t.projectType, tasks: [] };
    acc[t.projectPath].tasks.push(t);
    return acc;
  }, {});

  function toggleProject(path: string) {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleSelectProjectTask(task: ProjectTask) {
    setSelectedTask(task);
    setSelectedJobId(null);
    // Load script content
    const res = await window.electronAPI?.readTaskScript(task.scriptPath);
    if (res && 'content' in res) {
      setScriptDraft(res.content);
      setScriptName(task.taskName);
      // Auto-select matching server if @server hint matches
      if (task.serverHint) {
        const match = servers.find(s => s.name === task.serverHint);
        if (match) setSelectedServerId(match.id);
      }
    } else if (res && 'error' in res) {
      alert(`Script konnte nicht gelesen werden: ${res.error}`);
    }
  }
  useEffect(() => {
    if (!selectedServerId) return;
    refreshJobs(selectedServerId);
    refreshSchedules(selectedServerId);
    const t = window.setInterval(() => {
      refreshJobs(selectedServerId);
      refreshSchedules(selectedServerId);
    }, 5000);
    return () => window.clearInterval(t);
  }, [selectedServerId, refreshJobs, refreshSchedules]);

  // Auto-scroll log to bottom
  useEffect(() => { logEndRef.current?.scrollIntoView({ block: 'end' }); }, [logText]);

  // Load artifacts for the selected job (and re-fetch when its status changes)
  const selectedJobStatus = jobs.find(j => j.id === selectedJobId)?.status;
  useEffect(() => {
    if (!selectedServerId || !selectedJobId) { setArtifacts([]); return; }
    let cancelled = false;
    window.electronAPI?.taskServerListArtifacts(selectedServerId, selectedJobId).then(res => {
      if (cancelled) return;
      setArtifacts(Array.isArray(res) ? res : []);
    });
    return () => { cancelled = true; };
  }, [selectedServerId, selectedJobId, selectedJobStatus]);

  async function handleDownloadArtifact(name: string) {
    if (!selectedServerId || !selectedJobId) return;
    setDownloadingArtifact(name);
    try {
      const res = await window.electronAPI?.taskServerDownloadArtifact(selectedServerId, selectedJobId, name);
      if (res?.success && res.path) {
        // Could show a toast — keep it simple for now
        console.log(`[artifact] saved to ${res.path}`);
      } else if (res && !res.canceled && res.error) {
        alert(`Download fehlgeschlagen: ${res.error}`);
      }
    } finally {
      setDownloadingArtifact(null);
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // Subscribe to log stream when a job is selected
  useEffect(() => {
    if (!selectedServerId || !selectedJobId) {
      setLogText('');
      return;
    }
    setLogText('');
    const streamId = `${selectedJobId}-${Date.now()}`;
    streamIdRef.current = streamId;
    const stopFn = window.electronAPI?.onTaskJobLogChunk((data) => {
      if (data.streamId !== streamId) return;
      if (data.error) setLogText(prev => prev + `\n[stream-error] ${data.error}\n`);
      if (data.text != null) setLogText(prev => prev + data.text + '\n');
      if (data.end) { /* completion: refresh job list to pick up final status */
        if (selectedServerId) refreshJobs(selectedServerId);
      }
    });
    stopChunkListenerRef.current = stopFn || null;
    window.electronAPI?.taskServerStreamLog(selectedServerId, selectedJobId, streamId);
    return () => {
      if (streamIdRef.current) window.electronAPI?.taskServerStopStream(streamIdRef.current);
      streamIdRef.current = null;
      if (stopChunkListenerRef.current) stopChunkListenerRef.current();
      stopChunkListenerRef.current = null;
    };
  }, [selectedServerId, selectedJobId, refreshJobs]);

  async function handleRun() {
    if (!selectedServerId || !scriptDraft.trim()) return;
    setRunning(true);
    try {
      // Tag the job with project meta if it came from a project-task selection
      const meta = selectedTask ? {
        projectId: selectedTask.projectPath.replace(/\//g, '-'),
        projectName: selectedTask.projectName,
        taskName: selectedTask.taskName,
        source: 'ui',
      } : { source: 'ui-adhoc' };
      const res = await window.electronAPI?.taskServerCreateJob(selectedServerId, {
        script: scriptDraft,
        name: scriptName.trim() || undefined,
        meta,
      });
      if (res && 'id' in res) {
        setSelectedJobId(res.id);
        refreshJobs(selectedServerId);
      } else if (res && 'error' in res) {
        alert(`Job konnte nicht gestartet werden: ${res.error}`);
      }
    } finally {
      setRunning(false);
    }
  }

  async function handleKill(jobId: string) {
    if (!selectedServerId) return;
    await window.electronAPI?.taskServerKillJob(selectedServerId, jobId);
    refreshJobs(selectedServerId);
  }

  function handleScheduleJob(job: TaskJob, e?: React.MouseEvent) {
    e?.stopPropagation();
    setShowScheduleModal({ job });
  }

  async function handleCreateSchedule(cronExpr: string) {
    if (!showScheduleModal || !selectedServerId) return;
    const j = showScheduleModal.job;
    const res = await window.electronAPI?.taskServerCreateSchedule(selectedServerId, {
      cronExpr,
      script: j.script,
      name: j.name,
      meta: j.meta,
    });
    if (res && 'error' in res) {
      alert(`Schedule fehlgeschlagen: ${res.error}`);
      return;
    }
    setShowScheduleModal(null);
    refreshSchedules(selectedServerId);
  }

  async function handleToggleSchedule(s: TaskSchedule) {
    if (!selectedServerId) return;
    await window.electronAPI?.taskServerUpdateSchedule(selectedServerId, s.id, { enabled: !s.enabled });
    refreshSchedules(selectedServerId);
  }

  async function handleDeleteSchedule(s: TaskSchedule) {
    if (!selectedServerId) return;
    if (!confirm(`Schedule "${s.name || s.cronExpr}" löschen?`)) return;
    await window.electronAPI?.taskServerDeleteSchedule(selectedServerId, s.id);
    refreshSchedules(selectedServerId);
  }

  async function handleRetryJob(job: TaskJob, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (!selectedServerId) return;
    const meta = job.meta ? { ...job.meta, source: 'retry' } : { source: 'retry' };
    const res = await window.electronAPI?.taskServerCreateJob(selectedServerId, {
      script: job.script,
      name: job.name,
      meta,
    });
    if (res && 'id' in res) {
      setSelectedJobId(res.id);
      refreshJobs(selectedServerId);
    } else if (res && 'error' in res) {
      alert(`Retry fehlgeschlagen: ${res.error}`);
    }
  }

  async function handleDeleteJob(jobId: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (!selectedServerId) return;
    if (!confirm('Job aus der Historie löschen? (Logs + Artefakte werden auch entfernt)')) return;
    const r = await window.electronAPI?.taskServerDeleteJob(selectedServerId, jobId);
    if (r?.error) alert(`Löschen fehlgeschlagen: ${r.error}`);
    if (selectedJobId === jobId) setSelectedJobId(null);
    refreshJobs(selectedServerId);
  }

  async function handleDeleteFinishedJobs() {
    if (!selectedServerId) return;
    if (!confirm('Alle erledigten Jobs (done/failed/killed) inkl. Logs und Artefakte löschen?')) return;
    const r = await window.electronAPI?.taskServerDeleteJobsBulk(selectedServerId, ['done', 'failed', 'killed']);
    if (r?.error) alert(`Bulk-Löschen fehlgeschlagen: ${r.error}`);
    setSelectedJobId(null);
    refreshJobs(selectedServerId);
  }


  const selectedServer = servers.find(s => s.id === selectedServerId);
  const selectedJob = jobs.find(j => j.id === selectedJobId);

  return (
    <div className="panel-view tasks-panel rtaskmc-panel">
      <div className="panel-header">
        <h2 className="panel-title">RTaskMC</h2>
        <div className="rtaskmc-header-server">
          {selectedServer ? (
            <span title={selectedServer.baseUrl}>🔑 {selectedServer.name}</span>
          ) : (
            <span className="rtaskmc-no-server">⚠ kein Task-Server konfiguriert</span>
          )}
        </div>
        <div className="panel-header-actions">
          <button className="header-btn" onClick={loadProjectTasks} title="Tasks neu scannen">↻</button>
        </div>
      </div>

      <div className="tasks-layout rtaskmc-layout">
        {/* Col 1: project tasks + ad-hoc toggle */}
        <div className="tasks-projects">
          <div className="rtaskmc-source-tabs">
            <button
              className={`rtaskmc-source-tab ${taskSource === 'project' ? 'active' : ''}`}
              onClick={() => setTaskSource('project')}
            >Projekt-Tasks</button>
            <button
              className={`rtaskmc-source-tab ${taskSource === 'adhoc' ? 'active' : ''}`}
              onClick={() => { setTaskSource('adhoc'); setSelectedTask(null); }}
            >Ad-hoc</button>
          </div>
          {taskSource === 'project' && (
            <>
              {loadingTasks && <div className="tasks-empty">Scanne...</div>}
              {!loadingTasks && projectTasks.length === 0 && (
                <div className="tasks-empty">
                  Keine <code>tasks/*.sh</code> in deinen Projekten gefunden.
                  <br /><br />
                  Lege im Projekt einen Ordner <code>tasks/</code> mit Shell-Scripten an. Optional Frontmatter pro Datei:
                  <pre style={{ marginTop: 6, fontSize: 10 }}>{`# @desc: Was tut der Task
# @server: n8n VPS
# @env: DB_PASS,API_KEY`}</pre>
                </div>
              )}
              {Object.entries(tasksByProject).map(([projectPath, group]) => {
                const expanded = expandedProjects.has(projectPath);
                return (
                  <div key={projectPath} className="rtaskmc-project-group">
                    <div className="rtaskmc-project-header" onClick={() => toggleProject(projectPath)}>
                      <span className={`rtaskmc-project-arrow ${expanded ? 'expanded' : ''}`}>▶</span>
                      <span className={`rtaskmc-project-type type-${group.type}`}>{group.type === 'cowork' ? 'C' : 'P'}</span>
                      <span className="rtaskmc-project-name">{group.name}</span>
                      <span className="rtaskmc-project-count">{group.tasks.length}</span>
                    </div>
                    {expanded && group.tasks.map(t => (
                      <div
                        key={t.scriptPath}
                        className={`rtaskmc-task-item ${selectedTask?.scriptPath === t.scriptPath ? 'active' : ''}`}
                        onClick={() => handleSelectProjectTask(t)}
                      >
                        <div className="rtaskmc-task-name">▶ {t.taskName}</div>
                        {t.description && <div className="rtaskmc-task-desc">{t.description}</div>}
                        {t.serverHint && <div className="rtaskmc-task-hint">@ {t.serverHint}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}
          {taskSource === 'adhoc' && (
            <div className="tasks-empty" style={{ fontSize: 12 }}>
              Ad-hoc: rechts oben Server wählen, dann freies Script ins Feld eintippen und ▶ Job starten.
              <br /><br />
              Empfohlen: lege deine Scripte als <code>tasks/*.sh</code> ins Projekt-Repo — dann sind sie versioniert und teilbar.
            </div>
          )}
        </div>

        {/* Col 3: jobs list */}
        <div className="tasks-jobs">
          {schedules.length > 0 && (
            <>
              <div className="tasks-section-label">SCHEDULES ({schedules.length})</div>
              {schedules.map(s => (
                <div key={s.id} className={`tasks-schedule-item ${s.enabled ? '' : 'disabled'}`}>
                  <div className="tasks-schedule-row1">
                    <span className="tasks-schedule-name">{s.name || s.cronExpr}</span>
                    <button
                      className="tasks-schedule-toggle"
                      onClick={() => handleToggleSchedule(s)}
                      title={s.enabled ? 'Pausieren' : 'Aktivieren'}
                    >{s.enabled ? '⏸' : '▶'}</button>
                    <button
                      className="tasks-job-icon-btn tasks-job-delete-btn"
                      onClick={() => handleDeleteSchedule(s)}
                      title="Schedule löschen"
                    >✕</button>
                  </div>
                  <div className="tasks-schedule-row2">
                    <code>{s.cronExpr}</code>
                    {s.nextRunAt && s.enabled && <span> · nächster: {new Date(s.nextRunAt).toLocaleString()}</span>}
                  </div>
                </div>
              ))}
            </>
          )}
          <div className="tasks-section-label tasks-jobs-header">
            <span>JOBS {selectedServer && `(${jobs.length})`}</span>
            {jobs.some(j => j.status === 'done' || j.status === 'failed' || j.status === 'killed') && (
              <button
                className="tasks-bulk-clear-btn"
                onClick={handleDeleteFinishedJobs}
                title="Alle erledigten Jobs löschen (done/failed/killed)"
              >🗑 Erledigte</button>
            )}
          </div>
          {!selectedServer && <div className="tasks-empty">Server auswählen.</div>}
          {selectedServer && jobs.length === 0 && <div className="tasks-empty">Noch keine Jobs.</div>}
          {jobs.map(j => (
            <div
              key={j.id}
              className={`tasks-job-item ${statusClass(j.status)} ${selectedJobId === j.id ? 'active' : ''}`}
              onClick={() => setSelectedJobId(j.id)}
            >
              <div className="tasks-job-row1">
                <span className="tasks-job-status">{statusIcon(j.status)}</span>
                <span className="tasks-job-name">{j.name || j.script.split('\n')[0].slice(0, 50)}</span>
              </div>
              {j.meta?.projectName && (
                <div className="tasks-job-badge" title={j.meta.source ? `Quelle: ${j.meta.source}` : ''}>
                  <span className="tasks-job-badge-project">📂 {j.meta.projectName}</span>
                  {j.meta.taskName && <span className="tasks-job-badge-task">· {j.meta.taskName}</span>}
                </div>
              )}
              <div className="tasks-job-row2">
                <span className="tasks-job-time">{new Date(j.createdAt).toLocaleTimeString()}</span>
                {j.exitCode !== null && <span className="tasks-job-exit">exit {j.exitCode}</span>}
                <div className="tasks-job-actions">
                  <button
                    className="tasks-job-icon-btn"
                    onClick={(e) => handleRetryJob(j, e)}
                    title="Job wiederholen (gleiches Script)"
                  >🔁</button>
                  <button
                    className="tasks-job-icon-btn"
                    onClick={(e) => handleScheduleJob(j, e)}
                    title="Als Cron einplanen"
                  >⏰</button>
                  <button
                    className="tasks-job-icon-btn tasks-job-delete-btn"
                    onClick={(e) => handleDeleteJob(j.id, e)}
                    title="Job löschen"
                  >✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Right: run form + output */}
        <div className="tasks-detail">
          {!selectedJob && selectedServer && (
            <div className="tasks-run-form">
              <div className="tasks-section-label">NEUER JOB</div>
              <input
                className="tasks-input"
                type="text"
                placeholder="Name (optional)"
                value={scriptName}
                onChange={(e) => setScriptName(e.target.value)}
              />
              <textarea
                className="tasks-script"
                placeholder="#!/bin/bash&#10;echo &quot;Hier dein Script&quot;"
                value={scriptDraft}
                onChange={(e) => setScriptDraft(e.target.value)}
                rows={10}
              />
              <button
                className="tasks-run-btn"
                onClick={handleRun}
                disabled={running || !scriptDraft.trim()}
              >
                {running ? 'Starte...' : '▶ Job starten'}
              </button>
            </div>
          )}

          {selectedJob && (
            <div className="tasks-job-detail">
              <div className="tasks-job-header">
                <span className={`tasks-job-status-pill ${statusClass(selectedJob.status)}`}>
                  {statusIcon(selectedJob.status)} {selectedJob.status}
                </span>
                <span className="tasks-job-id">{selectedJob.id.slice(0, 8)}</span>
                <div style={{ flex: 1 }} />
                {selectedJob.status === 'running' && (
                  <button className="tasks-kill-btn" onClick={() => handleKill(selectedJob.id)}>■ Kill</button>
                )}
                <button className="tasks-back-btn" onClick={() => setSelectedJobId(null)}>← Neuer Job</button>
              </div>
              <pre className="tasks-script-preview">{selectedJob.script}</pre>
              <div className="tasks-log-container">
                <pre className="tasks-log">{logText || '(warte auf Output...)'}</pre>
                <div ref={logEndRef} />
              </div>
              {artifacts.length > 0 && (
                <div className="tasks-artifacts">
                  <div className="tasks-section-label">ARTEFAKTE ({artifacts.length})</div>
                  {artifacts.map(a => (
                    <div key={a.name} className="tasks-artifact-item">
                      <span className="tasks-artifact-icon">📄</span>
                      <span className="tasks-artifact-name">{a.name}</span>
                      <span className="tasks-artifact-size">{formatBytes(a.size)}</span>
                      <button
                        className="tasks-artifact-btn"
                        disabled={downloadingArtifact === a.name}
                        onClick={() => handleDownloadArtifact(a.name)}
                      >
                        {downloadingArtifact === a.name ? '...' : '⬇'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showScheduleModal && (
        <ScheduleModal
          job={showScheduleModal.job}
          onClose={() => setShowScheduleModal(null)}
          onCreate={handleCreateSchedule}
        />
      )}
    </div>
  );
}

function ScheduleModal({ job, onClose, onCreate }: { job: TaskJob; onClose: () => void; onCreate: (cronExpr: string) => void }) {
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Schedule für "{job.name || job.script.split('\n')[0].slice(0, 40)}"</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="modal-label">Cron-Expression (m h dom mon dow)</label>
          <input
            className="modal-input"
            type="text"
            value={cronExpr}
            onChange={e => setCronExpr(e.target.value)}
            placeholder="0 * * * *"
            spellCheck={false}
          />
          <div className="modal-hint" style={{ marginTop: 10 }}>Presets:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {CRON_PRESETS.map(p => (
              <button
                key={p.expr}
                className="modal-btn"
                style={{ fontSize: 11, padding: '4px 8px' }}
                onClick={() => setCronExpr(p.expr)}
              >{p.label}</button>
            ))}
          </div>
          <div className="modal-hint" style={{ marginTop: 12 }}>
            Script wird unverändert mit dem gleichen Namen/Meta gespeichert und periodisch ausgeführt. Output erscheint als normale Jobs in der Liste oben.
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose}>Abbrechen</button>
          <button className="modal-btn primary" onClick={() => onCreate(cronExpr.trim())} disabled={!cronExpr.trim()}>Schedule anlegen</button>
        </div>
      </div>
    </div>
  );
}
