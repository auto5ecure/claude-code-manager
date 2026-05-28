export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'killed';

// Origin metadata for a job — non-sensitive identifiers so the UI can
// attribute jobs to a project/task. Kept separate from `env` (secrets).
export interface JobMeta {
  projectId?: string;
  projectName?: string;
  taskName?: string;
  source?: string; // e.g. "agent", "ui", "cli"
}

export interface Job {
  id: string;
  script: string;
  env?: Record<string, string>;
  name?: string;
  meta?: JobMeta;
  status: JobStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  logPath: string;
}

export interface CreateJobRequest {
  script: string;
  env?: Record<string, string>;
  name?: string;
  meta?: JobMeta;
}

export interface Schedule {
  id: string;
  cronExpr: string;        // 5-field cron expression: m h dom mon dow
  script: string;
  name?: string;
  meta?: JobMeta;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface CreateScheduleRequest {
  cronExpr: string;
  script: string;
  name?: string;
  meta?: JobMeta;
  enabled?: boolean;
}
