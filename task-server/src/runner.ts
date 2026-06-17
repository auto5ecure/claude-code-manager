import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { Job, CreateJobRequest } from './types';
import { JobStore } from './store';

interface RunningProc {
  child: ChildProcess;
  emitter: EventEmitter; // emits 'data' (string), 'end' (exitCode)
}

export class JobRunner {
  private procs = new Map<string, RunningProc>();

  constructor(private store: JobStore, private logsDir: string, private artifactsDir: string) {}

  create(req: CreateJobRequest): Job {
    if (!req.script || typeof req.script !== 'string') {
      throw new Error('script (string) is required');
    }
    const language = req.language === 'node' ? 'node' : 'bash';
    const id = randomUUID();
    const logPath = path.join(this.logsDir, `${id}.log`);
    fs.writeFileSync(logPath, '');
    // Create per-job artifact dir; script can write here, files become downloadable
    fs.mkdirSync(path.join(this.artifactsDir, id), { recursive: true });
    const job: Job = {
      id,
      script: req.script,
      language,
      env: req.env,
      name: req.name,
      meta: req.meta,
      status: 'queued',
      pid: null,
      exitCode: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      logPath,
    };
    this.store.insert(job);
    this.start(job);
    return job;
  }

  private start(job: Job): void {
    const startedAt = new Date().toISOString();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    const logStream = fs.createWriteStream(job.logPath, { flags: 'a' });

    const artifactDir = path.join(this.artifactsDir, job.id);
    const env = {
      ...process.env,
      ...(job.env ?? {}),
      JOB_ID: job.id,
      JOB_ARTIFACT_DIR: artifactDir,
    };

    // Dispatch by language. Node scripts get written to a tmp .js file inside
    // the artifact dir so their stack traces point to a real file path and
    // `__dirname` / relative imports behave like a normal script.
    let child: ChildProcess;
    let scriptFile: string | null = null;
    if (job.language === 'node') {
      scriptFile = path.join(artifactDir, '_job.js');
      try { fs.writeFileSync(scriptFile, job.script); } catch (err) {
        // Surface the failure into the log so the UI shows what happened.
        logStream.write(`\n[runner-error] could not write node script: ${(err as Error).message}\n`);
      }
      // Resolve `playwright` from /app/node_modules so user scripts can require it
      // without their own install step.
      child = spawn('node', [scriptFile], {
        env: { ...env, NODE_PATH: '/app/node_modules' },
        cwd: artifactDir,
      });
    } else {
      child = spawn('bash', ['-c', job.script], { env, cwd: artifactDir });
    }

    this.store.update(job.id, { status: 'running', pid: child.pid ?? null, startedAt });
    this.procs.set(job.id, { child, emitter });

    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      logStream.write(text);
      emitter.emit('data', text);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      logStream.write(`\n[runner-error] ${err.message}\n`);
      emitter.emit('data', `\n[runner-error] ${err.message}\n`);
    });
    child.on('close', (code, signal) => {
      const finishedAt = new Date().toISOString();
      const status = signal ? 'killed' : code === 0 ? 'done' : 'failed';
      logStream.end();
      this.store.update(job.id, { status, exitCode: code ?? null, finishedAt });
      emitter.emit('end', { code, status });
      this.procs.delete(job.id);
    });
  }

  kill(id: string): boolean {
    const p = this.procs.get(id);
    if (!p) return false;
    try { p.child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { p.child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    return true;
  }

  // For SSE: stream existing log + future chunks until job ends.
  streamLog(id: string, onChunk: (text: string) => void, onEnd: () => void): () => void {
    const job = this.store.get(id);
    if (!job) {
      onEnd();
      return () => {};
    }
    // 1) Send existing log content
    try {
      const existing = fs.readFileSync(job.logPath, 'utf8');
      if (existing) onChunk(existing);
    } catch { /* file may not exist yet */ }

    // 2) If job already finished, end the stream now
    const proc = this.procs.get(id);
    if (!proc) { onEnd(); return () => {}; }

    // 3) Subscribe to live emitter
    const dataHandler = (text: string) => onChunk(text);
    const endHandler = () => onEnd();
    proc.emitter.on('data', dataHandler);
    proc.emitter.once('end', endHandler);
    return () => {
      proc.emitter.off('data', dataHandler);
      proc.emitter.off('end', endHandler);
    };
  }
}
