// Tiny cron scheduler: every 30s, check which schedules are due (next_run_at
// has passed) and dispatch them via the JobRunner. Uses cron-parser to compute
// next-fire times from standard 5-field cron expressions.
import parser from 'cron-parser';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { Schedule, CreateScheduleRequest } from './types';
import type { JobRunner } from './runner';

export class ScheduleStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        cron_expr TEXT NOT NULL,
        script TEXT NOT NULL,
        name TEXT,
        meta TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at);
    `);
    // Migration: add language column for existing deployments
    try {
      const cols = db.prepare(`PRAGMA table_info(schedules)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'language')) {
        db.exec(`ALTER TABLE schedules ADD COLUMN language TEXT`);
      }
    } catch { /* ignore */ }
  }

  list(): Schedule[] {
    const rows = this.db.prepare(`SELECT * FROM schedules ORDER BY created_at DESC`).all() as Record<string, unknown>[];
    return rows.map(r => this.rowToSchedule(r));
  }
  get(id: string): Schedule | null {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSchedule(row) : null;
  }
  insert(s: Schedule): void {
    this.db.prepare(`
      INSERT INTO schedules (id, cron_expr, script, language, name, meta, enabled, created_at, last_run_at, next_run_at)
      VALUES (@id, @cronExpr, @script, @language, @name, @meta, @enabled, @createdAt, @lastRunAt, @nextRunAt)
    `).run({
      ...s,
      language: s.language ?? null,
      meta: s.meta ? JSON.stringify(s.meta) : null,
      name: s.name ?? null,
      enabled: s.enabled ? 1 : 0,
    });
  }
  update(id: string, patch: Partial<Pick<Schedule, 'cronExpr' | 'enabled' | 'lastRunAt' | 'nextRunAt' | 'name' | 'script'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      const col = k === 'cronExpr' ? 'cron_expr' : k === 'lastRunAt' ? 'last_run_at' : k === 'nextRunAt' ? 'next_run_at' : k;
      fields.push(`${col} = @${k}`);
      values[k] = k === 'enabled' ? (v ? 1 : 0) : (v ?? null);
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }
  delete(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
    return r.changes > 0;
  }
  // For the scheduler tick: enabled + due
  due(now: Date): Schedule[] {
    const iso = now.toISOString();
    const rows = this.db.prepare(`SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`).all(iso) as Record<string, unknown>[];
    return rows.map(r => this.rowToSchedule(r));
  }
  private rowToSchedule(row: Record<string, unknown>): Schedule {
    return {
      id: row.id as string,
      cronExpr: row.cron_expr as string,
      script: row.script as string,
      language: ((row.language as string | null) ?? undefined) as Schedule['language'],
      name: (row.name as string) ?? undefined,
      meta: row.meta ? JSON.parse(row.meta as string) : undefined,
      enabled: (row.enabled as number) === 1,
      createdAt: row.created_at as string,
      lastRunAt: (row.last_run_at as string) ?? null,
      nextRunAt: (row.next_run_at as string) ?? null,
    };
  }
}

export function computeNextRun(cronExpr: string, after: Date = new Date()): string | null {
  try {
    const it = parser.parseExpression(cronExpr, { currentDate: after });
    return it.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export function validateCron(cronExpr: string): { ok: boolean; error?: string } {
  try {
    parser.parseExpression(cronExpr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function createSchedule(store: ScheduleStore, req: CreateScheduleRequest): Schedule {
  const validate = validateCron(req.cronExpr);
  if (!validate.ok) throw new Error(`Ungültige Cron-Expression: ${validate.error}`);
  if (!req.script) throw new Error('script ist Pflicht');
  const now = new Date();
  const s: Schedule = {
    id: randomUUID(),
    cronExpr: req.cronExpr,
    script: req.script,
    language: req.language === 'node' ? 'node' : 'bash',
    name: req.name,
    meta: req.meta,
    enabled: req.enabled ?? true,
    createdAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: computeNextRun(req.cronExpr, now),
  };
  store.insert(s);
  return s;
}

// Start the periodic check. Returns a stop function.
export function startScheduler(store: ScheduleStore, runner: JobRunner, intervalMs = 30_000): () => void {
  const tick = () => {
    const now = new Date();
    const due = store.due(now);
    for (const s of due) {
      try {
        // Mark next run BEFORE dispatching to prevent re-fire if dispatch is slow
        const next = computeNextRun(s.cronExpr, now);
        store.update(s.id, { lastRunAt: now.toISOString(), nextRunAt: next });
        runner.create({
          script: s.script,
          language: s.language,
          name: s.name,
          meta: { ...(s.meta || {}), source: `schedule:${s.id}` },
        });
      } catch (err) {
        console.error(`[scheduler] failed to dispatch schedule ${s.id}:`, err);
      }
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Fire once on startup so freshly-due schedules don't wait
  setTimeout(tick, 1000);
  return () => clearInterval(handle);
}
