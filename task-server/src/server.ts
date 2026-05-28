import Fastify from 'fastify';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { JobStore } from './store';
import { JobRunner } from './runner';
import { ScheduleStore, createSchedule, startScheduler, computeNextRun, validateCron } from './scheduler';
import type { CreateJobRequest, CreateScheduleRequest } from './types';

const PORT = Number(process.env.PORT || 4243);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const API_KEY = process.env.API_KEY || '';

if (!API_KEY) {
  console.error('[task-server] ERROR: API_KEY env var is required');
  process.exit(1);
}

const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
const store = new JobStore(DATA_DIR);
store.reconcileStartup();
const runner = new JobRunner(store, path.join(DATA_DIR, 'logs'), ARTIFACTS_DIR);

// Schedules use a separate connection to the same SQLite (WAL allows concurrent readers/writers)
const scheduleDb = new Database(path.join(DATA_DIR, 'jobs.sqlite'));
scheduleDb.pragma('journal_mode = WAL');
const scheduleStore = new ScheduleStore(scheduleDb);
const stopScheduler = startScheduler(scheduleStore, runner, 30_000);

const app = Fastify({ logger: { level: 'info' } });

// Auth hook — exempts /health for liveness probes
app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health') return;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing Bearer token' });
    return;
  }
  if (header.slice(7) !== API_KEY) {
    reply.code(401).send({ error: 'Invalid token' });
    return;
  }
});

app.get('/health', async () => ({ ok: true, version: '0.1.0' }));

app.post<{ Body: CreateJobRequest }>('/jobs', async (req, reply) => {
  try {
    const job = runner.create(req.body);
    return job;
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

app.get('/jobs', async () => store.list(100));

app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
  const job = store.get(req.params.id);
  if (!job) { reply.code(404); return { error: 'Job nicht gefunden' }; }
  return job;
});

// DELETE /jobs/:id — kills (if running) AND fully removes the job from DB,
// log file and artifact dir. For just stopping a job without deleting,
// nothing else changes since killed jobs end up in `killed` status.
app.delete<{ Params: { id: string }; Querystring: { keep?: string } }>('/jobs/:id', async (req, reply) => {
  const job = store.get(req.params.id);
  if (!job) { reply.code(404); return { error: 'Job nicht gefunden' }; }
  let wasRunning = false;
  if (job.status === 'running' || job.status === 'queued') {
    wasRunning = runner.kill(req.params.id);
  }
  // ?keep=1 → only kill, don't delete (backwards-compatible behavior)
  if (req.query.keep === '1') return { killed: wasRunning };

  // Wait briefly for the killed process to exit so its log finishes flushing
  if (wasRunning) await new Promise(r => setTimeout(r, 200));

  try { if (job.logPath) fs.unlinkSync(job.logPath); } catch { /* gone */ }
  try { fs.rmSync(path.join(ARTIFACTS_DIR, req.params.id), { recursive: true, force: true }); } catch { /* gone */ }
  store.delete(req.params.id);
  return { deleted: true, killed: wasRunning };
});

// Bulk delete: ?status=done,failed,killed  (running/queued never bulk-deleted to be safe)
app.delete<{ Querystring: { status?: string } }>('/jobs', async (req, reply) => {
  const allowed = ['done', 'failed', 'killed'];
  const requested = (req.query.status || 'done,failed,killed').split(',').map(s => s.trim()).filter(s => allowed.includes(s));
  if (requested.length === 0) {
    reply.code(400);
    return { error: 'status muss eine Liste aus done|failed|killed sein' };
  }
  const ids = store.deleteByStatus(requested);
  for (const id of ids) {
    try { fs.unlinkSync(path.join(DATA_DIR, 'logs', `${id}.log`)); } catch { /* gone */ }
    try { fs.rmSync(path.join(ARTIFACTS_DIR, id), { recursive: true, force: true }); } catch { /* gone */ }
  }
  return { deleted: ids.length };
});

// SSE log stream — each chunk arrives as an SSE `data:` event,
// terminated by an `event: end` marker when the job finishes.
app.get<{ Params: { id: string } }>('/jobs/:id/log', async (req, reply) => {
  const job = store.get(req.params.id);
  if (!job) { reply.code(404); return { error: 'Job nicht gefunden' }; }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  const send = (text: string) => {
    // SSE: split on newlines, prefix each with "data: "
    const lines = text.split('\n');
    for (const line of lines) {
      reply.raw.write(`data: ${line}\n`);
    }
    reply.raw.write('\n');
  };
  const sendEnd = () => {
    reply.raw.write('event: end\ndata: {}\n\n');
    reply.raw.end();
  };

  const unsub = runner.streamLog(req.params.id, send, sendEnd);
  req.raw.on('close', () => unsub());
});

// Artifacts: per-job files written under JOB_ARTIFACT_DIR
app.get<{ Params: { id: string } }>('/jobs/:id/artifacts', async (req, reply) => {
  const job = store.get(req.params.id);
  if (!job) { reply.code(404); return { error: 'Job nicht gefunden' }; }
  const dir = path.join(ARTIFACTS_DIR, req.params.id);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile())
      .map(e => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, size: st.size, modifiedAt: st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
});

app.get<{ Params: { id: string; name: string } }>('/jobs/:id/artifacts/:name', async (req, reply) => {
  const job = store.get(req.params.id);
  if (!job) { reply.code(404); return { error: 'Job nicht gefunden' }; }
  // Path-traversal guard — resolved path must stay inside the per-job dir
  const dir = path.resolve(ARTIFACTS_DIR, req.params.id);
  const filePath = path.resolve(dir, req.params.name);
  if (!filePath.startsWith(dir + path.sep)) {
    reply.code(400);
    return { error: 'Ungültiger Pfad' };
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    reply.code(404);
    return { error: 'Artefakt nicht gefunden' };
  }
  reply.header('Content-Disposition', `attachment; filename="${path.basename(req.params.name)}"`);
  reply.header('Content-Type', 'application/octet-stream');
  return reply.send(fs.createReadStream(filePath));
});

// ── Schedules (cron) ────────────────────────────────────────────────────────
app.get('/schedules', async () => scheduleStore.list());

app.post<{ Body: CreateScheduleRequest }>('/schedules', async (req, reply) => {
  try {
    const s = createSchedule(scheduleStore, req.body);
    return s;
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

app.get<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
  const s = scheduleStore.get(req.params.id);
  if (!s) { reply.code(404); return { error: 'Schedule nicht gefunden' }; }
  return s;
});

app.patch<{ Params: { id: string }; Body: Partial<{ cronExpr: string; enabled: boolean; name: string; script: string }> }>('/schedules/:id', async (req, reply) => {
  const s = scheduleStore.get(req.params.id);
  if (!s) { reply.code(404); return { error: 'Schedule nicht gefunden' }; }
  const patch: Record<string, unknown> = {};
  if (req.body.cronExpr !== undefined) {
    const v = validateCron(req.body.cronExpr);
    if (!v.ok) { reply.code(400); return { error: `Ungültige Cron-Expression: ${v.error}` }; }
    patch.cronExpr = req.body.cronExpr;
    patch.nextRunAt = computeNextRun(req.body.cronExpr);
  }
  if (req.body.enabled !== undefined) {
    patch.enabled = req.body.enabled;
    // Recompute next run when re-enabling so an old timestamp doesn't cause immediate fire
    if (req.body.enabled) patch.nextRunAt = computeNextRun(req.body.cronExpr || s.cronExpr);
  }
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.script !== undefined) patch.script = req.body.script;
  scheduleStore.update(req.params.id, patch);
  return scheduleStore.get(req.params.id);
});

app.delete<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
  const ok = scheduleStore.delete(req.params.id);
  if (!ok) { reply.code(404); return { error: 'Schedule nicht gefunden' }; }
  return { deleted: true };
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[task-server] listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => { stopScheduler(); process.exit(0); });
process.on('SIGINT', () => { stopScheduler(); process.exit(0); });
