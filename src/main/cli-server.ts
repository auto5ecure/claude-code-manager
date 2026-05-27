// Local HTTP server that exposes a small API for the `claudemc-task` CLI.
// Binds to 127.0.0.1 only. Token is rotated on every app start and written
// to ~/.claude/claudemc-cli.json (mode 0600).
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { TaskJobMeta } from '../shared/types';

interface RunTaskRequest {
  projectPath: string;
  taskName: string;
  source?: string;
}

type RunTaskHandler = (req: RunTaskRequest) => Promise<{ jobId: string; serverUrl: string; serverName: string } | { error: string }>;
type ListTasksHandler = (projectPath: string) => Promise<Array<{ taskName: string; description?: string; serverHint?: string }>>;

export interface CliServerState {
  port: number;
  token: string;
  apiUrl: string;
  shutdown: () => void;
}

export async function startCliServer(handlers: {
  onRunTask: RunTaskHandler;
  onListTasks: ListTasksHandler;
}): Promise<CliServerState> {
  const token = crypto.randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    // Always JSON
    res.setHeader('Content-Type', 'application/json');

    // Health is unauthenticated
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Auth check
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/run-task') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body) as RunTaskRequest;
          if (!parsed.projectPath || !parsed.taskName) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'projectPath und taskName sind Pflicht' }));
            return;
          }
          const result = await handlers.onRunTask(parsed);
          if ('error' in result) {
            res.statusCode = 400;
            res.end(JSON.stringify(result));
          } else {
            res.statusCode = 200;
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/list-tasks')) {
      // /list-tasks?projectPath=...
      const url = new URL(req.url, 'http://127.0.0.1');
      const projectPath = url.searchParams.get('projectPath');
      if (!projectPath) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'projectPath query param fehlt' }));
        return;
      }
      handlers.onListTasks(projectPath).then(tasks => {
        res.statusCode = 200;
        res.end(JSON.stringify(tasks));
      }).catch(err => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Bind to 127.0.0.1 on a free port chosen by the kernel
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;

  // Write connection info for the CLI to read
  const cliInfoPath = path.join(os.homedir(), '.claude', 'claudemc-cli.json');
  fs.mkdirSync(path.dirname(cliInfoPath), { recursive: true });
  fs.writeFileSync(cliInfoPath, JSON.stringify({ apiUrl, token, pid: process.pid }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cliInfoPath, 0o600); } catch { /* mode may not apply on some FS */ }

  console.log(`[cli-server] listening on ${apiUrl} — token in ${cliInfoPath}`);

  return {
    port,
    token,
    apiUrl,
    shutdown: () => {
      try { server.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(cliInfoPath); } catch { /* ignore */ }
    },
  };
}

// Helper used by the IPC handler to enrich a script POST with the right Bearer
// token + base URL based on a project task's @server frontmatter hint.
export function pickTaskServerForHint(servers: Array<{ name: string; baseUrl: string }>, serverHint?: string): { name: string; baseUrl: string } | null {
  if (servers.length === 0) return null;
  if (!serverHint) return servers[0]; // default to first
  const exact = servers.find(s => s.name === serverHint);
  return exact ?? servers[0];
}

export type { TaskJobMeta };
