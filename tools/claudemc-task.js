#!/usr/bin/env node
// claudemc-task — tiny CLI to trigger jobs from inside a project (or a sub-agent).
// Talks to ClaudeMC's local API (see src/main/cli-server.ts).
//
// Connection info is read from:
//   1. env: CLAUDEMC_API + CLAUDEMC_TOKEN
//   2. ~/.claude/claudemc-cli.json (rotated each app start)
//
// Project is resolved from:
//   1. env: CLAUDEMC_PROJECT_PATH
//   2. current working directory
//
// Usage:
//   claudemc-task list                # list available tasks for the current project
//   claudemc-task run <name>          # start a task — returns the job id
//   claudemc-task run <name> --wait   # also stream the log until done (exit-code matches job)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

function loadCliInfo() {
  if (process.env.CLAUDEMC_API && process.env.CLAUDEMC_TOKEN) {
    return { apiUrl: process.env.CLAUDEMC_API, token: process.env.CLAUDEMC_TOKEN };
  }
  const p = path.join(os.homedir(), '.claude', 'claudemc-cli.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    if (!j.apiUrl || !j.token) throw new Error('claudemc-cli.json fehlt apiUrl oder token');
    return j;
  } catch (err) {
    die(`Keine Verbindungsinfo. ClaudeMC läuft?\n  Suche env CLAUDEMC_API/TOKEN oder Datei ${p}\n  Fehler: ${err.message}`);
  }
}

function resolveProjectPath() {
  if (process.env.CLAUDEMC_PROJECT_PATH) return process.env.CLAUDEMC_PROJECT_PATH;
  // Walk upwards from cwd looking for a `tasks/` dir
  let cur = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cur, 'tasks')) || fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function request(method, apiUrl, token, pathname, body) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(pathname, apiUrl); } catch (err) { reject(err); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request({
      method, headers,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => {
        const code = res.statusCode || 0;
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep raw */ }
        if (code >= 200 && code < 300) resolve(parsed);
        else reject(new Error(`HTTP ${code}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Stream a job's SSE log via the local API (token stays on the Mac side).
// Returns the exit code derived from the final job status.
function streamLogViaLocal(apiUrl, localToken, jobId) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`/job-log?id=${encodeURIComponent(jobId)}`, apiUrl); }
    catch (err) { resolve(1); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Authorization': `Bearer ${localToken}`, 'Accept': 'text/event-stream' },
    }, (res) => {
      let buffer = '';
      let ended = false;
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const i = buffer.indexOf('\n\n');
          if (i < 0) break;
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const lines = block.split('\n');
          let isEnd = false;
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('event: end')) isEnd = true;
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length) process.stdout.write(dataLines.join('\n') + '\n');
          if (isEnd) {
            ended = true;
            res.destroy();
            // Status holen, exit-code daraus ableiten
            request('GET', apiUrl, localToken, `/job-status?id=${encodeURIComponent(jobId)}`)
              .then(job => resolve(job && typeof job.exitCode === 'number' ? job.exitCode : 0))
              .catch(() => resolve(0));
            return;
          }
        }
      });
      res.on('end', () => { if (!ended) resolve(0); });
      res.on('error', () => { if (!ended) resolve(1); });
    });
    req.on('error', () => resolve(1));
    req.end();
  });
}

function die(msg) { console.error(`claudemc-task: ${msg}`); process.exit(2); }

(async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const info = loadCliInfo();
  const projectPath = resolveProjectPath();

  if (cmd === 'list' || cmd === 'ls') {
    const tasks = await request('GET', info.apiUrl, info.token, `/list-tasks?projectPath=${encodeURIComponent(projectPath)}`)
      .catch(err => die(err.message));
    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log(`(keine tasks/*.sh in ${projectPath})`);
      return;
    }
    console.log(`Verfügbare Tasks in ${projectPath}:`);
    for (const t of tasks) {
      const desc = t.description ? `  — ${t.description}` : '';
      const srv = t.serverHint ? `  [@${t.serverHint}]` : '';
      console.log(`  ${t.taskName}${desc}${srv}`);
    }
    return;
  }

  if (cmd === 'run') {
    const taskName = argv[1];
    if (!taskName) die('usage: claudemc-task run <name> [--wait] [--env KEY=VAL] [--env-file <path>]');
    const wait = argv.includes('--wait');

    // Collect env from --env-file first (lowest precedence), then individual --env (overrides)
    const env = {};
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--env-file') {
        const filePath = argv[i + 1];
        if (!filePath) die('--env-file braucht einen Pfad');
        i++;
        let raw;
        try { raw = fs.readFileSync(filePath, 'utf8'); }
        catch (err) { die(`--env-file ${filePath}: ${err.message}`); }
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) continue;
          const eq = t.indexOf('=');
          if (eq <= 0) continue;
          let v = t.slice(eq + 1);
          // strip optional surrounding quotes
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          env[t.slice(0, eq)] = v;
        }
      }
    }
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--env') {
        const kv = argv[i + 1];
        if (!kv) die('--env braucht KEY=VAL');
        i++;
        const eq = kv.indexOf('=');
        if (eq <= 0) die(`--env-Wert "${kv}": KEY=VAL erwartet`);
        env[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }

    const body = { projectPath, taskName, source: 'cli' };
    if (Object.keys(env).length > 0) body.env = env;
    const res = await request('POST', info.apiUrl, info.token, '/run-task', body)
      .catch(err => die(err.message));
    console.log(`Job gestartet: ${res.jobId} (auf ${res.serverName})`);
    if (!wait) return;
    console.log('--- live log ---');
    const code = await streamLogViaLocal(info.apiUrl, info.token, res.jobId);
    process.exit(code);
  }

  if (cmd === 'status') {
    const jobId = argv[1];
    if (!jobId) die('usage: claudemc-task status <jobId>');
    const job = await request('GET', info.apiUrl, info.token, `/job-status?id=${encodeURIComponent(jobId)}`)
      .catch(err => die(err.message));
    console.log(`${job.status}  exit=${job.exitCode ?? '-'}  name=${job.name || '-'}  finished=${job.finishedAt || '-'}`);
    return;
  }

  if (cmd === 'log' || cmd === 'logs') {
    const jobId = argv[1];
    if (!jobId) die('usage: claudemc-task log <jobId>');
    const code = await streamLogViaLocal(info.apiUrl, info.token, jobId);
    process.exit(code);
  }

  if (cmd === '--help' || cmd === '-h' || !cmd) {
    console.log(`claudemc-task — trigger and inspect ClaudeMC remote tasks

Usage:
  claudemc-task list                              # list tasks in the current project
  claudemc-task run <name> [opts]                 # start a task on its task-server
  claudemc-task status <jobId>                    # one-line status of a job
  claudemc-task log <jobId>                       # stream log (backlog + live)

Options for run:
  --wait                  Stream log live + exit with the job's exit code
  --env KEY=VAL           Inject an env var into the bash process (repeatable)
  --env-file <path>       Read KEY=VAL lines from a file (# comments allowed).
                          --env-file is applied first, individual --env override.

Examples:
  claudemc-task run deploy --wait
  claudemc-task run nvr-check --env HIKAPI_USER=admin --env HIKAPI_PASS=secret
  claudemc-task run db-backup --env-file ./.env --wait

Project is resolved from:
  CLAUDEMC_PROJECT_PATH env, or the nearest ancestor containing tasks/ or .git
ClaudeMC API connection from:
  CLAUDEMC_API + CLAUDEMC_TOKEN env, or ~/.claude/claudemc-cli.json`);
    return;
  }

  die(`Unknown command: ${cmd}. Try --help`);
})().catch(err => die(err.message));
