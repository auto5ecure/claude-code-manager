import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { Job, JobStatus } from './types';

export class JobStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'jobs.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        script TEXT NOT NULL,
        name TEXT,
        meta TEXT,
        status TEXT NOT NULL,
        pid INTEGER,
        exit_code INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        log_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    `);
    // Migration: drop legacy env column (Phase-1 stored secrets); add meta if missing
    try {
      const cols = this.db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
      if (cols.some(c => c.name === 'env')) {
        this.db.exec(`ALTER TABLE jobs DROP COLUMN env`);
      }
      if (!cols.some(c => c.name === 'meta')) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN meta TEXT`);
      }
    } catch { /* SQLite < 3.35 doesn't support DROP COLUMN; ignore */ }
  }

  insert(job: Job): void {
    // env is intentionally NOT persisted — may contain secrets
    this.db.prepare(`
      INSERT INTO jobs (id, script, name, meta, status, pid, exit_code, created_at, started_at, finished_at, log_path)
      VALUES (@id, @script, @name, @meta, @status, @pid, @exitCode, @createdAt, @startedAt, @finishedAt, @logPath)
    `).run({
      ...job,
      name: job.name ?? null,
      meta: job.meta ? JSON.stringify(job.meta) : null,
    });
  }

  update(id: string, patch: Partial<Pick<Job, 'status' | 'pid' | 'exitCode' | 'startedAt' | 'finishedAt'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      const col = k === 'exitCode' ? 'exit_code' : k === 'startedAt' ? 'started_at' : k === 'finishedAt' ? 'finished_at' : k;
      fields.push(`${col} = @${k}`);
      values[k] = v ?? null;
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }

  get(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : null;
  }

  list(limit = 100): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToJob(r));
  }

  // On startup: any 'running' job is stale (process is dead — server restarted)
  reconcileStartup(): void {
    this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ? WHERE status IN ('queued', 'running')`)
      .run(new Date().toISOString());
  }

  private rowToJob(row: Record<string, unknown>): Job {
    return {
      id: row.id as string,
      script: row.script as string,
      // env is never read back from DB — it's only in-memory during execution
      env: undefined,
      name: (row.name as string) ?? undefined,
      meta: row.meta ? JSON.parse(row.meta as string) : undefined,
      status: row.status as JobStatus,
      pid: (row.pid as number) ?? null,
      exitCode: (row.exit_code as number) ?? null,
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
      logPath: row.log_path as string,
    };
  }
}
