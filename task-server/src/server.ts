import Fastify from 'fastify';
import * as path from 'path';
import * as fs from 'fs';
import { JobStore } from './store';
import { JobRunner } from './runner';
import type { CreateJobRequest } from './types';

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

app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
  const ok = runner.kill(req.params.id);
  if (!ok) { reply.code(404); return { error: 'Job nicht aktiv' }; }
  return { killed: true };
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

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[task-server] listening on ${HOST}:${PORT}`);
});
