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

function streamLog(serverUrl, taskToken, jobId) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`/jobs/${encodeURIComponent(jobId)}/log`, serverUrl); } catch (err) { resolve(1); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: { 'Authorization': `Bearer ${taskToken}`, 'Accept': 'text/event-stream' },
    }, (res) => {
      let buffer = '';
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
          if (isEnd) { res.destroy(); resolve(0); return; }
        }
      });
      res.on('end', () => resolve(0));
      res.on('error', () => resolve(1));
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
    if (!taskName) die('usage: claudemc-task run <name> [--wait]');
    const wait = argv.includes('--wait');
    const res = await request('POST', info.apiUrl, info.token, '/run-task', { projectPath, taskName, source: 'cli' })
      .catch(err => die(err.message));
    console.log(`Job gestartet: ${res.jobId} (auf ${res.serverName}, ${res.serverUrl})`);
    if (!wait) return;
    // For --wait, we need the task-server's bearer token. Ask the local API for it.
    // For now: skip live streaming if no shared secret — just poll.
    process.stdout.write('(--wait mode: live-stream noch nicht implementiert; nutze RTaskMC für Output)\n');
    return;
  }

  if (cmd === '--help' || cmd === '-h' || !cmd) {
    console.log(`claudemc-task — trigger ClaudeMC project tasks from the shell

Usage:
  claudemc-task list             # list tasks in the current project
  claudemc-task run <name>       # start a task, returns the job id

Project is resolved from:
  CLAUDEMC_PROJECT_PATH env var, or the nearest ancestor containing tasks/ or .git
ClaudeMC API connection from:
  CLAUDEMC_API + CLAUDEMC_TOKEN env vars, or ~/.claude/claudemc-cli.json`);
    return;
  }

  die(`Unknown command: ${cmd}. Try --help`);
})().catch(err => die(err.message));
