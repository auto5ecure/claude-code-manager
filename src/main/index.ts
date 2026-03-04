import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import * as pty from 'node-pty';

// Git helper functions
function getGitBranch(projectPath: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch;
  } catch {
    return null;
  }
}

function isGitDirty(projectPath: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

let mainWindow: BrowserWindow | null = null;
const ptyProcesses: Map<string, pty.IPty> = new Map();

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CONFIG_PATH = path.join(app.getPath('userData'), 'projects.json');
const LOG_PATH = path.join(app.getPath('userData'), 'activity.log');

interface ProjectConfig {
  projects: Array<{ path: string; name: string; type?: 'tools' | 'projekt' }>;
}

// Project type templates - stored in app's userData directory
const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');

async function getTemplate(type: 'tools' | 'projekt'): Promise<string> {
  const templatePath = path.join(TEMPLATES_DIR, `${type}.md`);
  try {
    return await fs.promises.readFile(templatePath, 'utf-8');
  } catch {
    // Return default template if file doesn't exist
    return getDefaultTemplate(type);
  }
}

function getDefaultTemplate(type: 'tools' | 'projekt'): string {
  if (type === 'tools') {
    return `<!-- TEMPLATE: tools | VERSION: 1.1.0 | UPDATED: 2026-03-04 -->

# OPERATING MODE --- ENGINEERING TOOLBOX

You are NOT a chatbot. You are an ENGINEERING TOOLBOX operating inside a production repository.

Your purpose is execution --- not creativity.

You behave like a deterministic senior engineer. Predictable. Structured. Reliable.

---

## STEP 0 (MANDATORY)
Before ANY action, read these files if they exist:
- .env (environment variables and project config)
- CLAUDE.md, CONTEXT.md, DECISIONS.md, STATUS.md
- tasks/ folder

## CORE RULES
- Never introduce speculative changes
- Choose the safest known approach
- Stability > novelty
- No experiments without explicit approval

## SKILL MODEL
You operate using skills:
- debugging, refactoring, build fixing
- CI optimization, dependency analysis
- documentation consolidation, performance tuning

Pattern: Identify skill → Apply → Execute → Stop

## TARGET DOCUMENTS
| Document | Purpose | Limit |
|----------|---------|-------|
| .env | Environment config | key=value |
| CONTEXT.md | System overview | 120 lines |
| DECISIONS.md | Decision log | append-only |
| STATUS.md | Current state | 80 lines |

## BUILD TRUTH RULE
Assume NOTHING works. Reality comes only from:
- CI results, compiler output, test results, artifacts

## OUTPUT CONTRACT
Every response MUST end with:
\`\`\`
STATUS: DONE | RUNNING | BLOCKED
SKILL_USED: (skill name)
CHANGED_FILES:
- file
NEXT:
- next step
NEEDS_FROM_USER: (only if required)
\`\`\`

---
Less talking. More executing.
`;
  } else {
    return `<!-- TEMPLATE: projekt | VERSION: 1.1.0 | UPDATED: 2026-03-04 -->

# OPERATING MODE --- STAFF ENGINEERING TOOLBOX

You are NOT a chatbot. You are a deterministic ENGINEERING TOOLBOX operating inside a real production repository.

Your purpose is execution. Not creativity. Not experimentation.

---

## STEP 0 (MANDATORY)
Before ANY action, read these files if they exist:
- .env (environment variables and project config)
- CLAUDE.md, CONTEXT.md, DECISIONS.md, STATUS.md
- tasks/ folder
- README.md, docs/*, ARCHITECTURE.md

## CORE RULES
- Never introduce speculative changes
- Choose the lowest-risk solution
- Clarity > complexity
- Scan before proposing changes

## EXECUTION MODEL
1. **Scan** - Review existing documentation + .env
2. **Identify** - Find overlap and dependencies
3. **Propose** - Present plan with rationale
4. **WAIT** - Get explicit approval
5. **Execute** - Implement safely

## TARGET DOCUMENTS
| Document | Purpose | Limit |
|----------|---------|-------|
| .env | Environment config | key=value |
| CONTEXT.md | System overview | 120 lines |
| DECISIONS.md | Decision log | append-only |
| STATUS.md | Current state | 80 lines |
| TASKS/ | Task tracking | - |

## TOKEN DISCIPLINE
- No long explanations
- No repeated context
- Reasoning <5 lines
- Prefer bullets
- If response grows → compress

## BUILD TRUTH RULE
Assume NOTHING works. Reality comes only from:
- CI results, compiler output, test results, artifacts

## OUTPUT CONTRACT
Every response MUST end with:
\`\`\`
STATUS: DONE | RUNNING | BLOCKED
SKILL_USED: (skill name)
CHANGED_FILES:
- file
NEXT:
- next step
NEEDS_FROM_USER: (only if required)
\`\`\`

---
Less talking. More execution.
`;
  }
}

interface LogEntry {
  timestamp: string;
  type: 'command' | 'activity' | 'error';
  project?: string;
  message: string;
}

// Log functions
async function addLogEntry(type: LogEntry['type'], message: string, project?: string): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    type,
    project,
    message,
  };
  const line = JSON.stringify(entry) + '\n';
  await fs.promises.appendFile(LOG_PATH, line);
}

async function getLogEntries(limit = 100, projectFilter?: string): Promise<LogEntry[]> {
  try {
    const content = await fs.promises.readFile(LOG_PATH, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    let entries = lines.map((line) => JSON.parse(line) as LogEntry);

    if (projectFilter) {
      entries = entries.filter((e) => e.project === projectFilter);
    }

    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

async function clearLog(): Promise<void> {
  await fs.promises.writeFile(LOG_PATH, '');
}

async function loadProjectConfig(): Promise<ProjectConfig> {
  try {
    const content = await fs.promises.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { projects: [] };
  }
}

async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('get-app-path', () => app.getPath('userData'));

ipcMain.handle('get-projects', async () => {
  const config = await loadProjectConfig();
  const projects = [];

  for (const p of config.projects) {
    let hasClaudeMd = false;
    try {
      await fs.promises.access(path.join(p.path, 'CLAUDE.md'));
      hasClaudeMd = true;
    } catch {
      // No CLAUDE.md
    }

    const gitBranch = getGitBranch(p.path);
    const gitDirty = gitBranch ? isGitDirty(p.path) : false;

    projects.push({
      id: p.path.replace(/\//g, '-'),
      path: p.path,
      name: p.name || path.basename(p.path),
      parentPath: path.dirname(p.path),
      hasClaudeMd,
      gitBranch,
      gitDirty,
      type: p.type || 'projekt',
    });
  }

  return projects;
});

ipcMain.handle('select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Projekt hinzufügen',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const projectPath = result.filePaths[0];
  const config = await loadProjectConfig();

  // Check if already exists
  if (config.projects.some((p) => p.path === projectPath)) {
    return null; // Already exists
  }

  return projectPath;
});

ipcMain.handle('add-project-with-type', async (_event, projectPath: string, type: 'tools' | 'projekt') => {
  const config = await loadProjectConfig();

  // Check if already exists
  if (config.projects.some((p) => p.path === projectPath)) {
    return null;
  }

  let hasClaudeMd = false;
  try {
    await fs.promises.access(path.join(projectPath, 'CLAUDE.md'));
    hasClaudeMd = true;
  } catch {
    // No CLAUDE.md
  }

  const gitBranch = getGitBranch(projectPath);
  const gitDirty = gitBranch ? isGitDirty(projectPath) : false;

  const newProject = {
    path: projectPath,
    name: path.basename(projectPath),
    type,
  };

  config.projects.push(newProject);
  await saveProjectConfig(config);

  await addLogEntry('activity', `Projekt hinzugefügt (${type})`, newProject.name);

  return {
    id: projectPath.replace(/\//g, '-'),
    path: projectPath,
    name: newProject.name,
    parentPath: path.dirname(projectPath),
    hasClaudeMd,
    gitBranch,
    gitDirty,
    type,
  };
});

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Projekt hinzufügen',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const projectPath = result.filePaths[0];
  const config = await loadProjectConfig();

  // Check if already exists
  if (config.projects.some((p) => p.path === projectPath)) {
    return null;
  }

  let hasClaudeMd = false;
  try {
    await fs.promises.access(path.join(projectPath, 'CLAUDE.md'));
    hasClaudeMd = true;
  } catch {
    // No CLAUDE.md
  }

  const newProject = {
    path: projectPath,
    name: path.basename(projectPath),
    type: 'projekt' as const,
  };

  config.projects.push(newProject);
  await saveProjectConfig(config);

  return {
    id: projectPath.replace(/\//g, '-'),
    path: projectPath,
    name: newProject.name,
    parentPath: path.dirname(projectPath),
    hasClaudeMd,
  };
});

ipcMain.handle('add-project-by-path', async (_event, projectPath: string) => {
  const config = await loadProjectConfig();

  // Check if already exists
  if (config.projects.some((p) => p.path === projectPath)) {
    return null;
  }

  // Check if it's a directory
  try {
    const stat = await fs.promises.stat(projectPath);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  let hasClaudeMd = false;
  try {
    await fs.promises.access(path.join(projectPath, 'CLAUDE.md'));
    hasClaudeMd = true;
  } catch {
    // No CLAUDE.md
  }

  const gitBranch = getGitBranch(projectPath);
  const gitDirty = gitBranch ? isGitDirty(projectPath) : false;

  const newProject = {
    path: projectPath,
    name: path.basename(projectPath),
  };

  config.projects.push(newProject);
  await saveProjectConfig(config);

  return {
    id: projectPath.replace(/\//g, '-'),
    path: projectPath,
    name: newProject.name,
    parentPath: path.dirname(projectPath),
    hasClaudeMd,
    gitBranch,
    gitDirty,
  };
});

ipcMain.handle('remove-project', async (_event, projectPath: string) => {
  const config = await loadProjectConfig();
  config.projects = config.projects.filter((p) => p.path !== projectPath);
  await saveProjectConfig(config);
  return true;
});

ipcMain.handle('rename-project', async (_event, projectPath: string, newName: string) => {
  const config = await loadProjectConfig();
  const project = config.projects.find((p) => p.path === projectPath);
  if (project) {
    project.name = newName;
    await saveProjectConfig(config);
  }
  return true;
});

ipcMain.handle('set-project-type', async (_event, projectPath: string, type: 'tools' | 'projekt') => {
  const config = await loadProjectConfig();
  const project = config.projects.find((p) => p.path === projectPath);
  if (project) {
    project.type = type;
    await saveProjectConfig(config);
    await addLogEntry('activity', `Projekt-Typ geändert zu: ${type}`, path.basename(projectPath));
  }
  return true;
});

ipcMain.handle('get-template', async (_event, type: 'tools' | 'projekt') => {
  return await getTemplate(type);
});

ipcMain.handle('get-sessions', async (_event, projectId: string) => {
  const sessionsIndexPath = path.join(CLAUDE_DIR, 'projects', projectId, 'sessions-index.json');
  try {
    const content = await fs.promises.readFile(sessionsIndexPath, 'utf-8');
    const index = JSON.parse(content);
    return (index.entries || []).sort((a: { modified: string }, b: { modified: string }) =>
      b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
});

ipcMain.handle('get-global-settings', async () => {
  try {
    const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
    const content = await fs.promises.readFile(settingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
});

ipcMain.handle('get-claude-md', async () => {
  try {
    const mdPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
    return await fs.promises.readFile(mdPath, 'utf-8');
  } catch {
    return '';
  }
});

// Project actions
ipcMain.handle('open-in-finder', async (_event, projectPath: string) => {
  shell.showItemInFolder(projectPath);
});

ipcMain.handle('open-in-terminal', async (_event, projectPath: string) => {
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', projectPath]);
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${projectPath}"`], { shell: true });
  } else {
    spawn('x-terminal-emulator', ['--working-directory', projectPath]);
  }
});

ipcMain.handle('start-claude', async (_event, projectPath: string) => {
  if (process.platform === 'darwin') {
    spawn('osascript', [
      '-e', `tell application "Terminal" to do script "cd '${projectPath}' && claude"`
    ]);
  } else {
    spawn('claude', [], { cwd: projectPath, shell: true });
  }
});

// Project CLAUDE.md
ipcMain.handle('get-project-claude-md', async (_event, projectPath: string) => {
  try {
    const mdPath = path.join(projectPath, 'CLAUDE.md');
    return await fs.promises.readFile(mdPath, 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('save-project-claude-md', async (_event, projectPath: string, content: string) => {
  const mdPath = path.join(projectPath, 'CLAUDE.md');
  await fs.promises.writeFile(mdPath, content, 'utf-8');
  return true;
});

ipcMain.handle('get-project-files', async (_event, projectPath: string) => {
  async function getFileInfo(filePath: string) {
    try {
      const stats = await fs.promises.stat(filePath);
      return { exists: true, size: stats.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async function getDirInfo(dirPath: string) {
    try {
      const files = await fs.promises.readdir(dirPath);
      return { exists: true, count: files.length };
    } catch {
      return { exists: false, count: 0 };
    }
  }

  return {
    claudeMd: await getFileInfo(path.join(projectPath, 'CLAUDE.md')),
    contextMd: await getFileInfo(path.join(projectPath, 'CONTEXT.md')),
    decisionsMd: await getFileInfo(path.join(projectPath, 'DECISIONS.md')),
    statusMd: await getFileInfo(path.join(projectPath, 'STATUS.md')),
    tasksDir: await getDirInfo(path.join(projectPath, 'TASKS')),
  };
});

// Project settings (in .claude/projects/...)
ipcMain.handle('get-project-settings', async (_event, projectId: string) => {
  try {
    const settingsPath = path.join(CLAUDE_DIR, 'projects', projectId, 'settings.local.json');
    const content = await fs.promises.readFile(settingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
});

ipcMain.handle('save-project-settings', async (_event, projectId: string, settings: object) => {
  const settingsPath = path.join(CLAUDE_DIR, 'projects', projectId, 'settings.local.json');
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  return true;
});

// Terminal PTY (multi-tab support)
ipcMain.handle('pty-spawn', async (_event, tabId: string, cwd: string, cols: number = 80, rows: number = 24, runClaude: boolean = false, autoAccept: boolean = false) => {
  // Kill existing process for this tab if any
  const existingPty = ptyProcesses.get(tabId);
  if (existingPty) {
    existingPty.kill();
    ptyProcesses.delete(tabId);
  }

  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';

  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: cwd,
    env: process.env as { [key: string]: string },
  });

  ptyProcesses.set(tabId, ptyProcess);

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send('pty-data', tabId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
  });

  if (runClaude) {
    setTimeout(() => {
      const initPrompt = 'Lies .env und alle MD-Dateien (CLAUDE.md, CONTEXT.md, DECISIONS.md, STATUS.md) und den tasks/ Ordner falls vorhanden. Analysiere das Projekt kurz.';
      const claudeCmd = autoAccept
        ? `claude --dangerously-skip-permissions '${initPrompt}'\r`
        : `claude '${initPrompt}'\r`;
      ptyProcess.write(claudeCmd);
    }, 500);
    const logMsg = autoAccept ? 'Claude gestartet (auto-accept)' : 'Claude gestartet';
    await addLogEntry('command', logMsg, path.basename(cwd));
  } else {
    await addLogEntry('activity', 'Terminal geöffnet', path.basename(cwd));
  }

  return true;
});

ipcMain.on('pty-write', (_event, tabId: string, data: string) => {
  ptyProcesses.get(tabId)?.write(data);
});

ipcMain.on('pty-resize', (_event, tabId: string, cols: number, rows: number) => {
  ptyProcesses.get(tabId)?.resize(cols, rows);
});

ipcMain.handle('pty-kill', async (_event, tabId: string) => {
  const ptyProcess = ptyProcesses.get(tabId);
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcesses.delete(tabId);
  }
  return true;
});

// Clipboard screenshot
ipcMain.handle('get-clipboard-image', async () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }
  return image.toDataURL();
});

ipcMain.handle('save-screenshot', async (_event, projectPath: string, dataUrl: string) => {
  const screenshotsDir = path.join(projectPath, 'screenshots');
  await fs.promises.mkdir(screenshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot-${timestamp}.png`;
  const filePath = path.join(screenshotsDir, filename);

  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
  await fs.promises.writeFile(filePath, base64Data, 'base64');

  await addLogEntry('activity', `Screenshot gespeichert: ${filename}`, path.basename(projectPath));
  return filePath;
});

// Activity Log
ipcMain.handle('log-entry', async (_event, type: LogEntry['type'], message: string, project?: string) => {
  await addLogEntry(type, message, project);
  return true;
});

ipcMain.handle('get-log', async (_event, limit?: number, projectFilter?: string) => {
  return await getLogEntries(limit, projectFilter);
});

ipcMain.handle('clear-log', async () => {
  await clearLog();
  return true;
});
