// PlaywrightMC backend — browser orchestration, script CRUD, codegen, scripted runs.
//
// Design:
// - Browser handle lives module-level. One visible chromium per ClaudeMC instance.
// - Scripts are plain .js files in ~/.claude/playwright-scripts/, metadata in
//   ~/.claude/playwright-scripts.json. Runs spawn `node <file>` so users write
//   normal `require('playwright')` scripts — Playwright is resolved from the
//   bundled node_modules via NODE_PATH.
// - Codegen + script-run output is piped to renderer via 'playwright-output'
//   IPC events with a runId so multiple concurrent runs stay separated.
import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { Browser, Page } from 'playwright';
import type { PlaywrightScript, PlaywrightInstallStatus, PlaywrightBrowserState } from '../shared/types';

const SCRIPTS_DIR = path.join(os.homedir(), '.claude', 'playwright-scripts');
const META_FILE = path.join(os.homedir(), '.claude', 'playwright-scripts.json');

// Module-level browser state
let currentBrowser: Browser | null = null;
let currentPage: Page | null = null;

// runId → child process map (for kill)
const runningProcesses = new Map<string, ChildProcess>();

// --- Filesystem helpers ----------------------------------------------------

function ensureDirs(): void {
  if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ scripts: [] }, null, 2));
}

function loadMeta(): { scripts: PlaywrightScript[] } {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  } catch {
    return { scripts: [] };
  }
}

function saveMeta(meta: { scripts: PlaywrightScript[] }): void {
  ensureDirs();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// --- Install status --------------------------------------------------------

function findChromiumPath(): string | undefined {
  // Playwright stores browsers in ~/Library/Caches/ms-playwright (macOS) or
  // ~/.cache/ms-playwright (Linux). Pick the highest version dir matching chromium-*.
  const candidates = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter(e => /^chromium-\d+$/.test(e));
    if (entries.length === 0) continue;
    entries.sort((a, b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]));
    return path.join(dir, entries[0]);
  }
  return undefined;
}

export async function getInstallStatus(): Promise<PlaywrightInstallStatus> {
  let version: string | undefined;
  let installed = false;
  try {
    version = require('playwright/package.json').version;
    installed = true;
  } catch { /* not installed */ }

  const chromiumPath = findChromiumPath();
  return {
    playwrightInstalled: installed,
    playwrightVersion: version,
    chromiumInstalled: !!chromiumPath,
    chromiumPath,
  };
}

// --- Browser control -------------------------------------------------------

export async function openBrowser(url: string): Promise<{ success: boolean; error?: string; title?: string }> {
  try {
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!currentBrowser) {
      currentBrowser = await chromium.launch({ headless: false });
      currentBrowser.on('disconnected', () => {
        currentBrowser = null;
        currentPage = null;
      });
    }
    if (!currentPage || currentPage.isClosed()) {
      currentPage = await currentBrowser.newPage();
    }
    if (url) await currentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await currentPage.title().catch(() => '');
    return { success: true, title };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function closeBrowser(): Promise<{ success: boolean }> {
  try {
    if (currentBrowser) await currentBrowser.close();
  } catch { /* ignore */ }
  currentBrowser = null;
  currentPage = null;
  return { success: true };
}

export async function getBrowserState(): Promise<PlaywrightBrowserState> {
  if (!currentBrowser || !currentPage || currentPage.isClosed()) {
    return { isOpen: false };
  }
  try {
    return {
      isOpen: true,
      currentUrl: currentPage.url(),
      title: await currentPage.title().catch(() => ''),
    };
  } catch {
    return { isOpen: false };
  }
}

export async function takeScreenshot(savePath?: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!currentPage || currentPage.isClosed()) return { success: false, error: 'Kein Browser offen' };
  try {
    const out = savePath || path.join(os.tmpdir(), `playwright-screenshot-${Date.now()}.png`);
    await currentPage.screenshot({ path: out, fullPage: true });
    return { success: true, path: out };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function savePdf(savePath?: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!currentPage || currentPage.isClosed()) return { success: false, error: 'Kein Browser offen' };
  try {
    const out = savePath || path.join(os.tmpdir(), `playwright-${Date.now()}.pdf`);
    await currentPage.pdf({ path: out, format: 'A4' });
    return { success: true, path: out };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function dumpHtml(): Promise<{ success: boolean; html?: string; error?: string }> {
  if (!currentPage || currentPage.isClosed()) return { success: false, error: 'Kein Browser offen' };
  try {
    const html = await currentPage.content();
    return { success: true, html };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function evalJs(code: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!currentPage || currentPage.isClosed()) return { success: false, error: 'Kein Browser offen' };
  try {
    const fn = new Function('return (async () => { ' + code + ' })()');
    const result = await currentPage.evaluate(fn as () => unknown);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// --- Script CRUD -----------------------------------------------------------

export function listScripts(): PlaywrightScript[] {
  const meta = loadMeta();
  // Filter out entries whose file disappeared.
  return meta.scripts.filter(s => fs.existsSync(s.filePath));
}

export function getScript(id: string): { script: PlaywrightScript; code: string } | null {
  const s = loadMeta().scripts.find(x => x.id === id);
  if (!s || !fs.existsSync(s.filePath)) return null;
  return { script: s, code: fs.readFileSync(s.filePath, 'utf-8') };
}

export function saveScript(input: { id?: string; name: string; code: string; description?: string }): PlaywrightScript {
  ensureDirs();
  const meta = loadMeta();
  const now = new Date().toISOString();
  let entry = input.id ? meta.scripts.find(s => s.id === input.id) : undefined;
  if (entry) {
    entry.name = input.name;
    entry.description = input.description;
    entry.updatedAt = now;
    fs.writeFileSync(entry.filePath, input.code);
  } else {
    const id = crypto.randomUUID();
    const safeName = input.name.replace(/[^\w.-]+/g, '-').toLowerCase() || `script-${Date.now()}`;
    const filename = safeName.endsWith('.js') ? safeName : `${safeName}.js`;
    const filePath = path.join(SCRIPTS_DIR, filename);
    fs.writeFileSync(filePath, input.code);
    entry = {
      id,
      name: input.name,
      filename,
      filePath,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
    meta.scripts.push(entry);
  }
  saveMeta(meta);
  return entry;
}

export function deleteScript(id: string): { success: boolean } {
  const meta = loadMeta();
  const idx = meta.scripts.findIndex(s => s.id === id);
  if (idx < 0) return { success: false };
  const entry = meta.scripts[idx];
  try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ }
  meta.scripts.splice(idx, 1);
  saveMeta(meta);
  return { success: true };
}

// --- Spawning + live output ------------------------------------------------

function emit(window: BrowserWindow | null, runId: string, channel: 'stdout' | 'stderr' | 'exit', payload: string | number): void {
  window?.webContents.send('playwright-output', { runId, channel, payload });
}

function nodePathEnv(): NodeJS.ProcessEnv {
  // Make `require('playwright')` work for spawned scripts even when invoked
  // outside of the project's cwd. We resolve our bundled playwright location
  // and prepend its parent dir to NODE_PATH.
  const isDev = !app.isPackaged;
  const root = isDev ? app.getAppPath() : process.resourcesPath;
  // In production: app.asar is read-only but app.asar.unpacked contains native deps.
  // playwright + playwright-core stay inside app.asar (pure JS), so NODE_PATH must
  // point into the asar — which Electron handles transparently for require().
  const nodeModulesCandidates = [
    path.join(root, 'node_modules'),
    path.join(root, 'app.asar', 'node_modules'),
  ];
  const existing = process.env.NODE_PATH || '';
  return {
    ...process.env,
    NODE_PATH: [...nodeModulesCandidates, existing].filter(Boolean).join(path.delimiter),
  };
}

export function runScript(
  window: BrowserWindow | null,
  scriptId: string,
): { success: boolean; runId?: string; error?: string } {
  const entry = loadMeta().scripts.find(s => s.id === scriptId);
  if (!entry || !fs.existsSync(entry.filePath)) {
    return { success: false, error: 'Script nicht gefunden' };
  }
  const runId = crypto.randomUUID();
  const child = spawn(process.execPath, [entry.filePath], {
    env: { ...nodePathEnv(), ELECTRON_RUN_AS_NODE: '1' },
    cwd: SCRIPTS_DIR,
  });
  runningProcesses.set(runId, child);
  child.stdout.on('data', (buf) => emit(window, runId, 'stdout', buf.toString('utf-8')));
  child.stderr.on('data', (buf) => emit(window, runId, 'stderr', buf.toString('utf-8')));
  child.on('exit', (code) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'exit', code ?? -1);
    // Update lastRunAt + exit code in metadata
    const meta = loadMeta();
    const m = meta.scripts.find(s => s.id === scriptId);
    if (m) {
      m.lastRunAt = new Date().toISOString();
      m.lastRunExitCode = code;
      saveMeta(meta);
    }
  });
  child.on('error', (err) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'stderr', `Spawn-Fehler: ${err.message}\n`);
    emit(window, runId, 'exit', -1);
  });
  return { success: true, runId };
}

export function killRun(runId: string): { success: boolean } {
  const proc = runningProcesses.get(runId);
  if (!proc) return { success: false };
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
  return { success: true };
}

// --- Codegen ---------------------------------------------------------------

export function startCodegen(
  window: BrowserWindow | null,
  opts: { url: string; scriptName: string },
): { success: boolean; runId?: string; targetFile?: string; error?: string } {
  ensureDirs();
  const safe = opts.scriptName.replace(/[^\w.-]+/g, '-').toLowerCase() || `recording-${Date.now()}`;
  const filename = safe.endsWith('.js') ? safe : `${safe}.js`;
  const targetFile = path.join(SCRIPTS_DIR, filename);

  // Find the playwright CLI shipped with our bundled playwright dependency.
  let cliPath: string;
  try {
    cliPath = require.resolve('playwright/cli.js');
  } catch (err) {
    return { success: false, error: `Playwright CLI nicht gefunden: ${(err as Error).message}` };
  }

  const runId = crypto.randomUUID();
  // codegen <url> -o <file> --target javascript
  const args = [cliPath, 'codegen', opts.url, '-o', targetFile, '--target', 'javascript'];
  const child = spawn(process.execPath, args, {
    env: { ...nodePathEnv(), ELECTRON_RUN_AS_NODE: '1' },
  });
  runningProcesses.set(runId, child);
  child.stdout.on('data', (buf) => emit(window, runId, 'stdout', buf.toString('utf-8')));
  child.stderr.on('data', (buf) => emit(window, runId, 'stderr', buf.toString('utf-8')));
  child.on('exit', (code) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'exit', code ?? -1);
    // If codegen wrote a file, register it as a script
    if (fs.existsSync(targetFile)) {
      const meta = loadMeta();
      const existing = meta.scripts.find(s => s.filePath === targetFile);
      const now = new Date().toISOString();
      if (!existing) {
        meta.scripts.push({
          id: crypto.randomUUID(),
          name: opts.scriptName || filename.replace(/\.js$/, ''),
          filename,
          filePath: targetFile,
          description: `Aufgezeichnet von ${opts.url}`,
          createdAt: now,
          updatedAt: now,
        });
        saveMeta(meta);
      }
    }
  });
  child.on('error', (err) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'stderr', `Codegen-Fehler: ${err.message}\n`);
    emit(window, runId, 'exit', -1);
  });
  return { success: true, runId, targetFile };
}

// --- Browser install -------------------------------------------------------

export function installChromium(window: BrowserWindow | null): { success: boolean; runId?: string; error?: string } {
  let cliPath: string;
  try {
    cliPath = require.resolve('playwright/cli.js');
  } catch (err) {
    return { success: false, error: `Playwright CLI nicht gefunden: ${(err as Error).message}` };
  }
  const runId = crypto.randomUUID();
  const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
    env: { ...nodePathEnv(), ELECTRON_RUN_AS_NODE: '1' },
  });
  runningProcesses.set(runId, child);
  child.stdout.on('data', (buf) => emit(window, runId, 'stdout', buf.toString('utf-8')));
  child.stderr.on('data', (buf) => emit(window, runId, 'stderr', buf.toString('utf-8')));
  child.on('exit', (code) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'exit', code ?? -1);
  });
  child.on('error', (err) => {
    runningProcesses.delete(runId);
    emit(window, runId, 'stderr', `Install-Fehler: ${err.message}\n`);
    emit(window, runId, 'exit', -1);
  });
  return { success: true, runId };
}
