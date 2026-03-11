import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import * as pty from 'node-pty';

// Get app version from package.json
const packageJson = require('../../package.json');
const APP_VERSION = packageJson.version;

// Claude Code check functions
interface ClaudeCodeStatus {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
  instructions?: string;
}

function checkClaudeCode(): ClaudeCodeStatus {
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), 'node_modules/.bin/claude'),
  ];

  // Try which/where first
  try {
    const claudePath = execSync(process.platform === 'win32' ? 'where claude' : 'which claude', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0];

    if (claudePath) {
      // Try to get version
      try {
        const version = execSync(`"${claudePath}" --version`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        return { installed: true, version, path: claudePath };
      } catch {
        return { installed: true, path: claudePath };
      }
    }
  } catch {
    // which/where failed, try common paths
  }

  // Check common paths
  for (const claudePath of commonPaths) {
    try {
      fs.accessSync(claudePath, fs.constants.X_OK);
      try {
        const version = execSync(`"${claudePath}" --version`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        return { installed: true, version, path: claudePath };
      } catch {
        return { installed: true, path: claudePath };
      }
    } catch {
      // Path doesn't exist or not executable
    }
  }

  // Not found - return instructions
  const isMac = process.platform === 'darwin';
  const isAppleSilicon = isMac && os.arch() === 'arm64';

  let instructions = `Claude Code ist nicht installiert oder nicht im PATH.\n\n`;
  instructions += `Installation:\n\n`;

  if (isMac) {
    instructions += `1. Node.js installieren:\n`;
    instructions += `   brew install node\n\n`;
    instructions += `   Oder: https://nodejs.org herunterladen\n\n`;
    instructions += `2. Claude Code installieren:\n`;
    instructions += `   npm install -g @anthropic-ai/claude-code\n\n`;
    instructions += `3. Falls "command not found":\n`;
    if (isAppleSilicon) {
      instructions += `   echo 'export PATH="$PATH:/opt/homebrew/bin"' >> ~/.zshrc\n`;
    } else {
      instructions += `   echo 'export PATH="$PATH:/usr/local/bin"' >> ~/.zshrc\n`;
    }
    instructions += `   source ~/.zshrc\n\n`;
    instructions += `4. Terminal neu öffnen und erneut versuchen.`;
  } else if (process.platform === 'win32') {
    instructions += `1. Node.js installieren: https://nodejs.org\n\n`;
    instructions += `2. PowerShell als Admin öffnen:\n`;
    instructions += `   npm install -g @anthropic-ai/claude-code\n\n`;
    instructions += `3. Terminal neu öffnen.`;
  } else {
    instructions += `1. Node.js installieren:\n`;
    instructions += `   sudo apt install nodejs npm\n\n`;
    instructions += `2. Claude Code installieren:\n`;
    instructions += `   npm install -g @anthropic-ai/claude-code\n\n`;
    instructions += `3. Terminal neu öffnen.`;
  }

  return {
    installed: false,
    error: 'Claude Code nicht gefunden',
    instructions,
  };
}

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

// Cowork Git helper functions
function gitFetch(repoPath: string, remote: string): { success: boolean; error?: string } {
  try {
    execSync(`git fetch ${remote}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function getAheadBehind(repoPath: string, remote: string, branch: string): { ahead: number; behind: number } {
  try {
    const result = execSync(`git rev-list --left-right --count ${remote}/${branch}...HEAD`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parts = result.split(/\s+/);
    return {
      behind: parseInt(parts[0], 10) || 0,
      ahead: parseInt(parts[1], 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function getChangedFiles(repoPath: string): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!status) return [];
    return status.split('\n').map((line) => line.slice(3));
  } catch {
    return [];
  }
}

function gitPull(repoPath: string, remote: string, branch: string): { success: boolean; error?: string } {
  try {
    execSync(`git pull ${remote} ${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function gitCommitAndPush(repoPath: string, message: string, remote: string, branch: string): { success: boolean; error?: string } {
  try {
    // Stage all changes
    execSync('git add -A', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Push
    execSync(`git push ${remote} ${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function hasConflicts(repoPath: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Check for unmerged files (conflicts)
    return status.split('\n').some((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'));
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
const COWORK_CONFIG_PATH = path.join(app.getPath('userData'), 'cowork-repositories.json');

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
  // Set app icon
  const iconPath = path.join(__dirname, '../../build/icon.png');
  let appIcon;
  try {
    appIcon = nativeImage.createFromPath(iconPath);
  } catch {
    // Icon not found, continue without
  }

  // Set dock icon on macOS
  if (process.platform === 'darwin' && appIcon && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: appIcon,
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

// Single instance lock - only allow one instance of the app
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window when a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

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
}

// IPC handlers
ipcMain.handle('get-app-path', () => app.getPath('userData'));

ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('check-claude-code', () => checkClaudeCode());

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
  const projectDir = path.join(CLAUDE_DIR, 'projects', projectId);
  const settingsPath = path.join(projectDir, 'settings.local.json');
  // Create directory if it doesn't exist
  await fs.promises.mkdir(projectDir, { recursive: true });
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

// Cowork Repository types and functions
interface CoworkRepository {
  id: string;
  name: string;
  localPath: string;
  githubUrl: string;
  remote: string;
  branch: string;
  lastSync?: string;
  hasCLAUDEmd: boolean;
}

interface CoworkConfig {
  repositories: CoworkRepository[];
}

async function loadCoworkConfig(): Promise<CoworkConfig> {
  try {
    const content = await fs.promises.readFile(COWORK_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { repositories: [] };
  }
}

async function saveCoworkConfig(config: CoworkConfig): Promise<void> {
  await fs.promises.writeFile(COWORK_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Cowork IPC handlers
ipcMain.handle('get-cowork-repositories', async () => {
  const config = await loadCoworkConfig();
  const repos = [];

  for (const repo of config.repositories) {
    let hasCLAUDEmd = false;
    try {
      await fs.promises.access(path.join(repo.localPath, 'CLAUDE.md'));
      hasCLAUDEmd = true;
    } catch {
      // No CLAUDE.md
    }

    repos.push({
      ...repo,
      hasCLAUDEmd,
    });
  }

  return repos;
});

ipcMain.handle('add-cowork-repository', async (_event, repo: Omit<CoworkRepository, 'id' | 'hasCLAUDEmd'>) => {
  const config = await loadCoworkConfig();

  // Check if already exists
  if (config.repositories.some((r) => r.localPath === repo.localPath)) {
    return { success: false, error: 'Repository bereits vorhanden' };
  }

  // Check if path exists
  try {
    const stat = await fs.promises.stat(repo.localPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Pfad ist kein Ordner' };
    }
  } catch {
    return { success: false, error: 'Pfad existiert nicht' };
  }

  let hasCLAUDEmd = false;
  try {
    await fs.promises.access(path.join(repo.localPath, 'CLAUDE.md'));
    hasCLAUDEmd = true;
  } catch {
    // No CLAUDE.md
  }

  const newRepo: CoworkRepository = {
    id: repo.localPath.replace(/\//g, '-'),
    name: repo.name,
    localPath: repo.localPath,
    githubUrl: repo.githubUrl,
    remote: repo.remote,
    branch: repo.branch,
    lastSync: repo.lastSync,
    hasCLAUDEmd,
  };

  config.repositories.push(newRepo);
  await saveCoworkConfig(config);

  await addLogEntry('activity', `Cowork-Repository hinzugefügt: ${newRepo.name}`);

  return { success: true, repository: newRepo };
});

ipcMain.handle('remove-cowork-repository', async (_event, repoId: string) => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  config.repositories = config.repositories.filter((r) => r.id !== repoId);
  await saveCoworkConfig(config);

  if (repo) {
    await addLogEntry('activity', `Cowork-Repository entfernt: ${repo.name}`);
  }

  return { success: true };
});

ipcMain.handle('get-cowork-sync-status', async (_event, localPath: string, remote: string, branch: string) => {
  // First fetch from remote
  const fetchResult = gitFetch(localPath, remote);
  if (!fetchResult.success) {
    return {
      state: 'conflict' as const,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false,
      changedFiles: [],
      error: fetchResult.error,
    };
  }

  const { ahead, behind } = getAheadBehind(localPath, remote, branch);
  const changedFiles = getChangedFiles(localPath);
  const hasUncommittedChanges = changedFiles.length > 0;
  const conflicts = hasConflicts(localPath);

  let state: 'synced' | 'behind' | 'ahead' | 'diverged' | 'conflict';
  if (conflicts) {
    state = 'conflict';
  } else if (ahead > 0 && behind > 0) {
    state = 'diverged';
  } else if (behind > 0) {
    state = 'behind';
  } else if (ahead > 0 || hasUncommittedChanges) {
    state = 'ahead';
  } else {
    state = 'synced';
  }

  return {
    state,
    ahead,
    behind,
    hasUncommittedChanges,
    changedFiles,
  };
});

ipcMain.handle('cowork-pull', async (_event, localPath: string, remote: string, branch: string) => {
  const result = gitPull(localPath, remote, branch);
  if (result.success) {
    await addLogEntry('activity', `Cowork Pull: ${path.basename(localPath)}`);
  } else {
    await addLogEntry('error', `Cowork Pull fehlgeschlagen: ${result.error}`, path.basename(localPath));
  }
  return result;
});

ipcMain.handle('cowork-commit-push', async (_event, localPath: string, message: string, remote: string, branch: string) => {
  const result = gitCommitAndPush(localPath, message, remote, branch);
  if (result.success) {
    await addLogEntry('activity', `Cowork Commit & Push: ${path.basename(localPath)}`);
  } else {
    await addLogEntry('error', `Cowork Commit & Push fehlgeschlagen: ${result.error}`, path.basename(localPath));
  }
  return result;
});

ipcMain.handle('update-cowork-last-sync', async (_event, repoId: string) => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  if (repo) {
    repo.lastSync = new Date().toISOString();
    await saveCoworkConfig(config);
  }
  return { success: true };
});

ipcMain.handle('create-cowork-claude-md', async (_event, localPath: string, content: string) => {
  const mdPath = path.join(localPath, 'CLAUDE.md');
  await fs.promises.writeFile(mdPath, content, 'utf-8');
  await addLogEntry('activity', `CLAUDE.md erstellt in: ${path.basename(localPath)}`);
  return { success: true };
});

// Get default repos directory
ipcMain.handle('get-cowork-repos-dir', async () => {
  const reposDir = path.join(app.getPath('userData'), 'repos');
  return reposDir;
});

// Check if path is a git repository
function isGitRepository(repoPath: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// Get remote URL from local repo
function getRemoteUrl(repoPath: string, remote: string): string | null {
  try {
    const url = execSync(`git remote get-url ${remote}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return url;
  } catch {
    return null;
  }
}

// Get current branch name
function getCurrentBranch(repoPath: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

// Get first available remote (usually "origin")
function getDefaultRemote(repoPath: string): string | null {
  try {
    const remotes = execSync('git remote', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);
    // Prefer "origin" if available, otherwise take first
    if (remotes.includes('origin')) return 'origin';
    return remotes[0] || null;
  } catch {
    return null;
  }
}

// Extract repo name from GitHub URL
function extractRepoName(githubUrl: string): string {
  const match = githubUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : 'repo';
}

// Validate cowork repository before adding
ipcMain.handle('validate-cowork-repository', async (_event, githubUrl: string, localPath?: string, _remote?: string, _branch?: string) => {
  const repoName = extractRepoName(githubUrl);
  const reposDir = path.join(app.getPath('userData'), 'repos');
  const defaultLocalPath = path.join(reposDir, repoName);

  const result: {
    valid: boolean;
    needsClone: boolean;
    localPath: string;
    repoName: string;
    error?: string;
    isGitRepo?: boolean;
    remoteMatch?: boolean;
    currentRemoteUrl?: string;
    detectedRemote?: string;
    detectedBranch?: string;
    syncStatus?: {
      state: string;
      ahead: number;
      behind: number;
      hasUncommittedChanges: boolean;
      changedFiles: string[];
    };
  } = {
    valid: false,
    needsClone: false,
    localPath: localPath || defaultLocalPath,
    repoName,
  };

  // If local path provided, check if it exists and is a git repo
  if (localPath) {
    try {
      const stat = await fs.promises.stat(localPath);
      if (!stat.isDirectory()) {
        result.error = 'Pfad ist kein Ordner';
        return result;
      }

      result.isGitRepo = isGitRepository(localPath);
      if (!result.isGitRepo) {
        result.error = 'Ordner ist kein Git-Repository';
        return result;
      }

      // Auto-detect remote and branch
      const detectedRemote = getDefaultRemote(localPath) || 'origin';
      const detectedBranch = getCurrentBranch(localPath) || 'main';
      result.detectedRemote = detectedRemote;
      result.detectedBranch = detectedBranch;

      // Check if remote URL matches
      const currentRemoteUrl = getRemoteUrl(localPath, detectedRemote);
      result.currentRemoteUrl = currentRemoteUrl || undefined;

      // Normalize URLs for comparison
      const normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
      result.remoteMatch = currentRemoteUrl ? normalizeUrl(currentRemoteUrl) === normalizeUrl(githubUrl) : false;

      if (!result.remoteMatch && currentRemoteUrl) {
        result.error = `Remote URL stimmt nicht überein. Erwartet: ${githubUrl}, Gefunden: ${currentRemoteUrl}`;
        return result;
      }

      // Fetch and get sync status
      const fetchResult = gitFetch(localPath, detectedRemote);
      if (fetchResult.success) {
        const { ahead, behind } = getAheadBehind(localPath, detectedRemote, detectedBranch);
        const changedFiles = getChangedFiles(localPath);
        const hasUncommittedChanges = changedFiles.length > 0;
        const conflicts = hasConflicts(localPath);

        let state: string;
        if (conflicts) {
          state = 'conflict';
        } else if (ahead > 0 && behind > 0) {
          state = 'diverged';
        } else if (behind > 0) {
          state = 'behind';
        } else if (ahead > 0 || hasUncommittedChanges) {
          state = 'ahead';
        } else {
          state = 'synced';
        }

        result.syncStatus = { state, ahead, behind, hasUncommittedChanges, changedFiles };
      }

      result.valid = true;
      result.needsClone = false;
    } catch {
      // Path doesn't exist
      result.error = 'Pfad existiert nicht';
      return result;
    }
  } else {
    // No local path - check if default path exists or needs clone
    try {
      await fs.promises.stat(defaultLocalPath);
      // Path exists, check if it's a valid git repo
      result.isGitRepo = isGitRepository(defaultLocalPath);
      if (result.isGitRepo) {
        result.valid = true;
        result.needsClone = false;

        // Auto-detect remote and branch
        const detectedRemote = getDefaultRemote(defaultLocalPath) || 'origin';
        const detectedBranch = getCurrentBranch(defaultLocalPath) || 'main';
        result.detectedRemote = detectedRemote;
        result.detectedBranch = detectedBranch;

        // Fetch and get sync status
        const fetchResult = gitFetch(defaultLocalPath, detectedRemote);
        if (fetchResult.success) {
          const { ahead, behind } = getAheadBehind(defaultLocalPath, detectedRemote, detectedBranch);
          const changedFiles = getChangedFiles(defaultLocalPath);
          const hasUncommittedChanges = changedFiles.length > 0;

          let state: string;
          if (ahead > 0 && behind > 0) {
            state = 'diverged';
          } else if (behind > 0) {
            state = 'behind';
          } else if (ahead > 0 || hasUncommittedChanges) {
            state = 'ahead';
          } else {
            state = 'synced';
          }

          result.syncStatus = { state, ahead, behind, hasUncommittedChanges, changedFiles };
        }
      } else {
        result.error = 'Ordner existiert aber ist kein Git-Repository';
      }
    } catch {
      // Path doesn't exist - needs clone
      result.valid = true;
      result.needsClone = true;
    }
  }

  return result;
});

// Clone a repository
// Cowork Lock System
const LOCK_FILENAME = '.cowork.lock';

interface CoworkLock {
  user: string;
  machine: string;
  timestamp: string;
  pid?: number;
}

function getUsername(): string {
  return os.userInfo().username || 'unknown';
}

function getMachineName(): string {
  return os.hostname() || 'unknown';
}

ipcMain.handle('check-cowork-lock', async (_event, repoPath: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);
  try {
    const content = await fs.promises.readFile(lockPath, 'utf-8');
    const lock: CoworkLock = JSON.parse(content);

    // Check if lock is stale (older than 2 hours)
    const lockTime = new Date(lock.timestamp).getTime();
    const now = Date.now();
    const twoHours = 2 * 60 * 60 * 1000;
    const isStale = (now - lockTime) > twoHours;

    // Check if it's our own lock
    const isOwnLock = lock.user === getUsername() && lock.machine === getMachineName();

    return {
      locked: true,
      lock,
      isStale,
      isOwnLock,
      age: Math.floor((now - lockTime) / 60000), // in minutes
    };
  } catch {
    return { locked: false };
  }
});

ipcMain.handle('create-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);

  const lock: CoworkLock = {
    user: getUsername(),
    machine: getMachineName(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };

  try {
    // Write lock file
    await fs.promises.writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf-8');

    // Git add, commit, push
    execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync(`git commit -m "🔒 Lock: ${lock.user}@${lock.machine} started working"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    await addLogEntry('activity', `Cowork Lock erstellt: ${path.basename(repoPath)}`);
    return { success: true, lock };
  } catch (err) {
    // Clean up lock file if commit/push failed
    try {
      await fs.promises.unlink(lockPath);
      execSync('git checkout -- .', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('release-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);

  try {
    // Check if lock file exists
    await fs.promises.access(lockPath);

    // Remove lock file
    await fs.promises.unlink(lockPath);

    // Git add, commit, push
    execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync(`git commit -m "🔓 Unlock: ${getUsername()}@${getMachineName()} finished working"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    await addLogEntry('activity', `Cowork Lock freigegeben: ${path.basename(repoPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('force-release-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);

  try {
    // First pull to get latest state
    execSync(`git pull ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    // Check if lock file exists
    try {
      await fs.promises.access(lockPath);
    } catch {
      return { success: true }; // Already unlocked
    }

    // Remove lock file
    await fs.promises.unlink(lockPath);

    // Git add, commit, push
    execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync(`git commit -m "🔓 Force Unlock: ${getUsername()}@${getMachineName()} (override)"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    await addLogEntry('activity', `Cowork Lock force-released: ${path.basename(repoPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('clone-cowork-repository', async (_event, githubUrl: string, targetPath: string) => {
  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    await fs.promises.mkdir(parentDir, { recursive: true });

    // Clone the repository
    execSync(`git clone "${githubUrl}" "${targetPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await addLogEntry('activity', `Repository geklont: ${path.basename(targetPath)}`);
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message;
    await addLogEntry('error', `Clone fehlgeschlagen: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
});

// ============================================
// DEPLOYMENT FEATURE
// ============================================

import type { DeploymentConfig, DeploymentStatus, ContainerInfo, DeploymentStep, DeploymentResult } from '../shared/types';

const DEPLOYMENT_CONFIG_FILE = '.deployment.json';

// SSH command helper
function sshExec(host: string, user: string, command: string, sshKeyPath?: string): { success: boolean; output: string; error?: string } {
  try {
    const keyArg = sshKeyPath ? `-i ${sshKeyPath.replace('~', os.homedir())}` : '';
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${keyArg} ${user}@${host} "${command.replace(/"/g, '\\"')}"`;
    const output = execSync(sshCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    const error = err as { stderr?: string; message?: string };
    return { success: false, output: '', error: error.stderr || error.message || 'SSH command failed' };
  }
}

// SCP helper
function scpUpload(localPath: string, host: string, user: string, remotePath: string, sshKeyPath?: string): { success: boolean; error?: string } {
  try {
    const keyArg = sshKeyPath ? `-i ${sshKeyPath.replace('~', os.homedir())}` : '';
    const scpCmd = `scp -o StrictHostKeyChecking=no ${keyArg} "${localPath}" ${user}@${host}:"${remotePath}"`;
    execSync(scpCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min timeout for large files
    });
    return { success: true };
  } catch (err) {
    const error = err as { stderr?: string; message?: string };
    return { success: false, error: error.stderr || error.message || 'SCP upload failed' };
  }
}

// Load deployment configs from all projects AND cowork repositories
async function loadDeploymentConfigs(): Promise<DeploymentConfig[]> {
  const configs: DeploymentConfig[] = [];
  const seenPaths = new Set<string>();

  // Load from regular projects
  const projectConfig = await loadProjectConfig();
  for (const project of projectConfig.projects) {
    const configPath = path.join(project.path, DEPLOYMENT_CONFIG_FILE);
    try {
      const data = await fs.promises.readFile(configPath, 'utf-8');
      const config: DeploymentConfig = JSON.parse(data);
      config.projectPath = project.path;
      config.id = config.id || project.path.replace(/\//g, '-');
      configs.push(config);
      seenPaths.add(project.path);
    } catch {
      // No deployment config for this project
    }
  }

  // Load from cowork repositories
  const coworkConfig = await loadCoworkConfig();
  for (const repo of coworkConfig.repositories) {
    if (seenPaths.has(repo.localPath)) continue; // Skip if already loaded
    const configPath = path.join(repo.localPath, DEPLOYMENT_CONFIG_FILE);
    try {
      const data = await fs.promises.readFile(configPath, 'utf-8');
      const config: DeploymentConfig = JSON.parse(data);
      config.projectPath = repo.localPath;
      config.id = config.id || repo.localPath.replace(/\//g, '-');
      configs.push(config);
    } catch {
      // No deployment config for this repo
    }
  }

  return configs;
}

// Save deployment config to project folder
async function saveDeploymentConfig(config: DeploymentConfig): Promise<void> {
  const configPath = path.join(config.projectPath, DEPLOYMENT_CONFIG_FILE);
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Remove deployment config from project folder
async function removeDeploymentConfig(projectPath: string): Promise<void> {
  const configPath = path.join(projectPath, DEPLOYMENT_CONFIG_FILE);
  await fs.promises.unlink(configPath);
}

// Get deployment configs
ipcMain.handle('get-deployment-configs', async () => {
  return await loadDeploymentConfigs();
});

// Add/Update deployment config (saves to project folder)
ipcMain.handle('add-deployment-config', async (_event, config: Omit<DeploymentConfig, 'id'>) => {
  try {
    const newConfig: DeploymentConfig = {
      ...config,
      id: config.projectPath.replace(/\//g, '-'),
    };
    await saveDeploymentConfig(newConfig);
    await addLogEntry('activity', `Deployment-Config erstellt: ${config.name}`);
    return { success: true, config: newConfig };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Remove deployment config (deletes .deployment.json from project)
ipcMain.handle('remove-deployment-config', async (_event, configId: string) => {
  try {
    const configs = await loadDeploymentConfigs();
    const config = configs.find(c => c.id === configId);
    if (config) {
      await removeDeploymentConfig(config.projectPath);
      await addLogEntry('activity', `Deployment-Config entfernt: ${config.name}`);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Check server status
ipcMain.handle('get-deployment-status', async (_event, config: DeploymentConfig): Promise<DeploymentStatus> => {
  const { server, urls } = config;

  // Check if server is reachable
  const pingResult = sshExec(server.host, server.user, 'echo "ok"', server.sshKeyPath);
  if (!pingResult.success) {
    return {
      isOnline: false,
      containers: [],
      error: pingResult.error,
    };
  }

  // Get container status
  const containersResult = sshExec(
    server.host,
    server.user,
    `docker ps --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null || echo ''`,
    server.sshKeyPath
  );

  const containers: ContainerInfo[] = [];
  if (containersResult.success && containersResult.output) {
    const lines = containersResult.output.split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, status, ports] = line.split('\t');
      if (name) {
        // Extract uptime from status (e.g., "Up 2 hours" -> "2 hours")
        const uptimeMatch = status?.match(/Up\s+(.+)/);
        containers.push({
          name,
          status: status || 'unknown',
          uptime: uptimeMatch ? uptimeMatch[1] : '',
          ports: ports || '',
        });
      }
    }
  }

  // Try to get version from health endpoint
  let currentVersion: string | undefined;
  try {
    const healthResult = execSync(`curl -s --max-time 5 "${urls.production}${urls.health}" 2>/dev/null || echo '{}'`, {
      encoding: 'utf-8',
    });
    const health = JSON.parse(healthResult);
    currentVersion = health.version;
  } catch {
    // Version unknown
  }

  return {
    isOnline: true,
    currentVersion,
    containers,
  };
});

// Get container logs
ipcMain.handle('get-deployment-logs', async (_event, config: DeploymentConfig, lines: number = 100): Promise<{ success: boolean; logs?: string; error?: string }> => {
  const { server, docker } = config;

  const result = sshExec(
    server.host,
    server.user,
    `docker logs ${docker.containerName} --tail ${lines} 2>&1`,
    server.sshKeyPath
  );

  if (result.success) {
    return { success: true, logs: result.output };
  }
  return { success: false, error: result.error };
});

// Run deployment
ipcMain.handle('run-deployment', async (event, config: DeploymentConfig): Promise<DeploymentResult> => {
  const { server, docker, projectPath } = config;
  const startTime = Date.now();

  const steps: DeploymentStep[] = [
    { id: 'git-check', label: 'Git Status prüfen', status: 'pending' },
    { id: 'server-check', label: 'Server erreichbar', status: 'pending' },
    { id: 'backup', label: 'Backup erstellen', status: 'pending' },
    { id: 'transfer', label: 'Source übertragen', status: 'pending' },
    { id: 'build', label: 'Docker Build', status: 'pending' },
    { id: 'deploy', label: 'Container starten', status: 'pending' },
    { id: 'health', label: 'Health Check', status: 'pending' },
  ];

  const updateStep = (id: string, status: DeploymentStep['status'], message?: string) => {
    const step = steps.find(s => s.id === id);
    if (step) {
      step.status = status;
      if (message) step.message = message;
    }
    // Send progress update to renderer
    event.sender.send('deployment-progress', { steps: [...steps] });
  };

  try {
    // Step 1: Git check
    updateStep('git-check', 'running');
    const gitStatus = isGitDirty(projectPath);
    if (gitStatus) {
      updateStep('git-check', 'error', 'Uncommitted changes vorhanden');
      return { success: false, duration: Date.now() - startTime, steps, error: 'Uncommitted changes vorhanden. Bitte erst committen.' };
    }
    updateStep('git-check', 'success');

    // Step 2: Server check
    updateStep('server-check', 'running');
    const serverCheck = sshExec(server.host, server.user, 'echo "ok"', server.sshKeyPath);
    if (!serverCheck.success) {
      updateStep('server-check', 'error', serverCheck.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Server nicht erreichbar: ${serverCheck.error}` };
    }
    updateStep('server-check', 'success');

    // Step 3: Backup current image
    updateStep('backup', 'running');
    const backupResult = sshExec(
      server.host,
      server.user,
      `docker tag ${docker.imageName}:latest ${docker.imageName}:backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || echo "No previous image"`,
      server.sshKeyPath
    );
    updateStep('backup', 'success', backupResult.output);

    // Step 4: Transfer source code
    updateStep('transfer', 'running');

    // Create tar archive (excluding unnecessary files)
    const tarPath = path.join(os.tmpdir(), `deploy-${Date.now()}.tar.gz`);
    try {
      execSync(`COPYFILE_DISABLE=1 tar -czvf "${tarPath}" --exclude='.git' --exclude='bin' --exclude='obj' --exclude='node_modules' --exclude='*.tar.gz' --exclude='._*' .`, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      updateStep('transfer', 'error', 'Tar-Archiv erstellen fehlgeschlagen');
      return { success: false, duration: Date.now() - startTime, steps, error: `Tar erstellen fehlgeschlagen: ${(err as Error).message}` };
    }

    // Upload to server
    const uploadResult = scpUpload(tarPath, server.host, server.user, `${server.directory}/deploy.tar.gz`, server.sshKeyPath);

    // Cleanup local tar
    try { fs.unlinkSync(tarPath); } catch { /* ignore */ }

    if (!uploadResult.success) {
      updateStep('transfer', 'error', uploadResult.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Upload fehlgeschlagen: ${uploadResult.error}` };
    }
    updateStep('transfer', 'success');

    // Step 5: Build Docker image on server
    updateStep('build', 'running');
    const buildResult = sshExec(
      server.host,
      server.user,
      `cd ${server.directory} && rm -rf src && mkdir -p src && tar -xzf deploy.tar.gz -C src && docker build -t ${docker.imageName}:latest -f src/${docker.dockerfile} src/ && rm deploy.tar.gz`,
      server.sshKeyPath
    );
    if (!buildResult.success) {
      updateStep('build', 'error', buildResult.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Docker Build fehlgeschlagen: ${buildResult.error}` };
    }
    updateStep('build', 'success');

    // Step 6: Deploy (restart container)
    updateStep('deploy', 'running');
    const deployResult = sshExec(
      server.host,
      server.user,
      `cd ${server.directory} && docker compose up -d`,
      server.sshKeyPath
    );
    if (!deployResult.success) {
      updateStep('deploy', 'error', deployResult.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Container starten fehlgeschlagen: ${deployResult.error}` };
    }
    updateStep('deploy', 'success');

    // Step 7: Health check
    updateStep('health', 'running');
    let healthOk = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const healthResult = execSync(`curl -s --max-time 5 "${config.urls.production}${config.urls.health}" 2>/dev/null`, {
          encoding: 'utf-8',
        });
        if (healthResult) {
          healthOk = true;
          break;
        }
      } catch {
        // Continue waiting
      }
    }

    if (!healthOk) {
      updateStep('health', 'error', 'Health Check Timeout');
      return { success: false, duration: Date.now() - startTime, steps, error: 'Health Check fehlgeschlagen nach 60 Sekunden' };
    }
    updateStep('health', 'success');

    await addLogEntry('activity', `Deployment erfolgreich: ${config.name}`);
    return { success: true, duration: Date.now() - startTime, steps };

  } catch (err) {
    await addLogEntry('error', `Deployment fehlgeschlagen: ${(err as Error).message}`);
    return { success: false, duration: Date.now() - startTime, steps, error: (err as Error).message };
  }
});

// Rollback deployment
ipcMain.handle('deployment-rollback', async (_event, config: DeploymentConfig): Promise<{ success: boolean; error?: string }> => {
  const { server, docker } = config;

  try {
    // Find latest backup image
    const listResult = sshExec(
      server.host,
      server.user,
      `docker images --format '{{.Repository}}:{{.Tag}}' | grep '${docker.imageName}:backup-' | head -1`,
      server.sshKeyPath
    );

    if (!listResult.success || !listResult.output) {
      return { success: false, error: 'Kein Backup-Image gefunden' };
    }

    const backupImage = listResult.output.trim();

    // Tag backup as latest and restart
    const rollbackResult = sshExec(
      server.host,
      server.user,
      `docker tag ${backupImage} ${docker.imageName}:latest && cd ${server.directory} && docker compose up -d`,
      server.sshKeyPath
    );

    if (!rollbackResult.success) {
      return { success: false, error: rollbackResult.error };
    }

    await addLogEntry('activity', `Rollback erfolgreich: ${config.name} -> ${backupImage}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Test SSH connection
ipcMain.handle('test-ssh-connection', async (_event, host: string, user: string, sshKeyPath?: string): Promise<{ success: boolean; error?: string }> => {
  const result = sshExec(host, user, 'echo "Connection successful"', sshKeyPath);
  return result.success ? { success: true } : { success: false, error: result.error };
});

// Import deployment config from JSON file into a specific project
ipcMain.handle('import-deployment-configs', async (): Promise<{ success: boolean; imported: number; error?: string }> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    title: 'Deployment-Konfiguration importieren',
    filters: [
      { name: 'JSON Dateien', extensions: ['json'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, imported: 0 };
  }

  try {
    const content = await fs.promises.readFile(result.filePaths[0], 'utf-8');
    let importedConfigs: DeploymentConfig | DeploymentConfig[] = JSON.parse(content);

    // Support both single config and array
    if (!Array.isArray(importedConfigs)) {
      importedConfigs = [importedConfigs];
    }

    const projectConfig = await loadProjectConfig();
    const existingConfigs = await loadDeploymentConfigs();
    let importedCount = 0;

    for (const config of importedConfigs) {
      // Validate config has required fields
      if (!config.name || !config.projectPath || !config.server || !config.urls || !config.docker) {
        continue;
      }

      // Check if project exists in our project list
      const projectExists = projectConfig.projects.some(p => p.path === config.projectPath);
      if (!projectExists) {
        // Try to find by project name
        const projectByName = projectConfig.projects.find(p => path.basename(p.path) === path.basename(config.projectPath));
        if (projectByName) {
          config.projectPath = projectByName.path;
        } else {
          continue; // Skip if project not found
        }
      }

      // Check if config already exists for this project
      const exists = existingConfigs.some(c => c.projectPath === config.projectPath);
      if (exists) {
        continue;
      }

      // Save to project folder
      const newConfig: DeploymentConfig = {
        ...config,
        id: config.projectPath.replace(/\//g, '-'),
      };

      await saveDeploymentConfig(newConfig);
      importedCount++;
    }

    await addLogEntry('activity', `${importedCount} Deployment-Config(s) importiert`);
    return { success: true, imported: importedCount };
  } catch (err) {
    return { success: false, imported: 0, error: (err as Error).message };
  }
});

// Export deployment configs to JSON file
ipcMain.handle('export-deployment-configs', async (): Promise<{ success: boolean; error?: string }> => {
  const configs = await loadDeploymentConfigs();

  if (configs.length === 0) {
    return { success: false, error: 'Keine Deployment-Konfigurationen vorhanden' };
  }

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Deployment-Konfigurationen exportieren',
    defaultPath: 'deployment-configs.json',
    filters: [
      { name: 'JSON Dateien', extensions: ['json'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { success: false };
  }

  try {
    await fs.promises.writeFile(result.filePath, JSON.stringify(configs, null, 2));
    await addLogEntry('activity', `${configs.length} Deployment-Config(s) exportiert`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Export cowork repositories to JSON file
ipcMain.handle('export-cowork-repositories', async (): Promise<{ success: boolean; error?: string }> => {
  const config = await loadCoworkConfig();

  if (config.repositories.length === 0) {
    return { success: false, error: 'Keine Cowork-Repositories vorhanden' };
  }

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Cowork-Repositories exportieren',
    defaultPath: 'cowork-repositories.json',
    filters: [
      { name: 'JSON Dateien', extensions: ['json'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { success: false };
  }

  try {
    // Export without hasCLAUDEmd as it's computed at runtime
    const exportData = config.repositories.map(repo => ({
      name: repo.name,
      localPath: repo.localPath,
      githubUrl: repo.githubUrl,
      remote: repo.remote,
      branch: repo.branch,
    }));
    await fs.promises.writeFile(result.filePath, JSON.stringify(exportData, null, 2));
    await addLogEntry('activity', `${config.repositories.length} Cowork-Repository(s) exportiert`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Import cowork repositories from JSON file
ipcMain.handle('import-cowork-repositories', async (): Promise<{ success: boolean; imported: number; error?: string }> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    title: 'Cowork-Repositories importieren',
    filters: [
      { name: 'JSON Dateien', extensions: ['json'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, imported: 0 };
  }

  try {
    const content = await fs.promises.readFile(result.filePaths[0], 'utf-8');
    let importedRepos: Array<{
      name: string;
      localPath: string;
      githubUrl: string;
      remote: string;
      branch: string;
    }> = JSON.parse(content);

    // Support both single repo and array
    if (!Array.isArray(importedRepos)) {
      importedRepos = [importedRepos];
    }

    const config = await loadCoworkConfig();
    let importedCount = 0;

    for (const repo of importedRepos) {
      // Validate required fields
      if (!repo.name || !repo.localPath || !repo.githubUrl || !repo.remote || !repo.branch) {
        continue;
      }

      // Check if already exists
      if (config.repositories.some(r => r.localPath === repo.localPath)) {
        continue;
      }

      // Check if path exists
      try {
        const stat = await fs.promises.stat(repo.localPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue; // Path doesn't exist, skip
      }

      // Add repository
      const newRepo: CoworkRepository = {
        id: repo.localPath.replace(/\//g, '-'),
        name: repo.name,
        localPath: repo.localPath,
        githubUrl: repo.githubUrl,
        remote: repo.remote,
        branch: repo.branch,
        hasCLAUDEmd: false, // Will be computed on load
      };

      config.repositories.push(newRepo);
      importedCount++;
    }

    if (importedCount > 0) {
      await saveCoworkConfig(config);
    }

    await addLogEntry('activity', `${importedCount} Cowork-Repository(s) importiert`);
    return { success: true, imported: importedCount };
  } catch (err) {
    return { success: false, imported: 0, error: (err as Error).message };
  }
});

// ============================================
// AUTO-UPDATER via Nextcloud
// ============================================

const UPDATE_SHARE_TOKEN = 'CfccibEAdNja7tc';
const UPDATE_WEBDAV_URL = 'https://nx65086.your-storageshare.de/public.php/webdav';

interface UpdateInfo {
  version: string;
  releaseDate: string;
  dmgUrl: string;
  zipUrl: string;
  notes?: string;
}

async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  const url = `${UPDATE_WEBDAV_URL}/version.json`;
  console.log('[Update] Fetching version info from:', url);
  await addLogEntry('activity', `[Update] Prüfe ${url}`);

  try {
    const https = await import('https');
    // Basic Auth with share token as username, empty password
    const auth = Buffer.from(`${UPDATE_SHARE_TOKEN}:`).toString('base64');

    return new Promise((resolve) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Claude-MC-Updater',
          'Authorization': `Basic ${auth}`
        }
      }, (res) => {
        console.log('[Update] Response status:', res.statusCode);

        if (res.statusCode !== 200) {
          console.error('[Update] HTTP error:', res.statusCode);
          resolve(null);
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('[Update] Parsed version info:', parsed);
            resolve(parsed);
          } catch (e) {
            console.error('[Update] Failed to parse JSON:', e, 'Data:', data.substring(0, 200));
            resolve(null);
          }
        });
      }).on('error', (e) => {
        console.error('[Update] Request error:', e);
        resolve(null);
      });
    });
  } catch (e) {
    console.error('[Update] fetchUpdateInfo exception:', e);
    return null;
  }
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

ipcMain.handle('check-for-updates', async (): Promise<{ available: boolean; latestVersion?: string; error?: string }> => {
  console.log('[Update] check-for-updates called');
  await addLogEntry('activity', '[Update] Starte Update-Check...');

  try {
    const updateInfo = await fetchUpdateInfo();
    if (!updateInfo) {
      const error = 'Konnte Update-Info nicht abrufen';
      console.error('[Update]', error);
      await addLogEntry('error', `[Update] ${error}`);
      return { available: false, error };
    }

    const currentVersion = app.getVersion();
    const latestVersion = updateInfo.version;
    const available = compareVersions(latestVersion, currentVersion) > 0;

    const logMsg = `[Update] Aktuell: v${currentVersion}, Server: v${latestVersion}, Update verfügbar: ${available}`;
    console.log(logMsg);
    await addLogEntry('activity', logMsg);

    if (available && updateInfo.notes) {
      await addLogEntry('activity', `[Update] Release Notes: ${updateInfo.notes}`);
    }

    return { available, latestVersion };
  } catch (err) {
    const error = (err as Error).message;
    console.error('[Update] check-for-updates error:', error);
    await addLogEntry('error', `[Update] Fehler: ${error}`);
    return { available: false, error };
  }
});

ipcMain.handle('download-update', async (event): Promise<{ success: boolean; error?: string }> => {
  console.log('[Update] download-update called');
  await addLogEntry('activity', '[Update] Starte Download...');

  try {
    const updateInfo = await fetchUpdateInfo();
    if (!updateInfo) {
      const error = 'Konnte Update-Info nicht abrufen';
      console.error('[Update]', error);
      await addLogEntry('error', `[Update] ${error}`);
      return { success: false, error };
    }

    const https = await import('https');
    const downloadUrl = process.platform === 'darwin' ? updateInfo.dmgUrl : updateInfo.zipUrl;

    console.log('[Update] Platform:', process.platform);
    console.log('[Update] Download URL:', downloadUrl);
    await addLogEntry('activity', `[Update] Download URL: ${downloadUrl}`);

    if (!downloadUrl) {
      const error = 'Kein Download für diese Plattform verfügbar';
      console.error('[Update]', error);
      await addLogEntry('error', `[Update] ${error}`);
      return { success: false, error };
    }

    const tempDir = app.getPath('temp');
    const fileName = process.platform === 'darwin' ? `Claude-MC-${updateInfo.version}.dmg` : `Claude-MC-${updateInfo.version}.zip`;
    const filePath = path.join(tempDir, fileName);

    console.log('[Update] Saving to:', filePath);
    await addLogEntry('activity', `[Update] Lade v${updateInfo.version} herunter nach: ${filePath}`);

    // Download with progress (using Basic Auth for WebDAV)
    const auth = Buffer.from(`${UPDATE_SHARE_TOKEN}:`).toString('base64');

    await new Promise<void>((resolve, reject) => {
      https.get(downloadUrl, {
        headers: {
          'User-Agent': 'Claude-MC-Updater',
          'Authorization': `Basic ${auth}`
        }
      }, (res) => {
        console.log('[Update] Download response status:', res.statusCode);

        if (res.statusCode !== 200) {
          reject(new Error(`Download fehlgeschlagen: HTTP ${res.statusCode}`));
          return;
        }

        const totalSize = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        console.log('[Update] Total size:', totalSize);

        const fileStream = fs.createWriteStream(filePath);

        res.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) {
            const progress = (downloadedSize / totalSize) * 100;
            event.sender.send('update-progress', progress);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });

        fileStream.on('error', (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
      }).on('error', reject);
    });

    console.log('[Update] Download complete:', filePath);
    await addLogEntry('activity', `[Update] Download abgeschlossen: ${filePath}`);

    // Open the downloaded file
    if (process.platform === 'darwin') {
      // Open DMG file
      console.log('[Update] Opening DMG...');
      await addLogEntry('activity', '[Update] Öffne DMG...');
      const { exec } = await import('child_process');
      exec(`open "${filePath}"`, (err) => {
        if (err) {
          console.error('[Update] Failed to open DMG:', err);
        } else {
          console.log('[Update] DMG opened, quitting app in 2s...');
          // Quit app after short delay to allow DMG to mount
          setTimeout(() => {
            app.quit();
          }, 2000);
        }
      });
    } else {
      // Open containing folder for other platforms
      console.log('[Update] Opening folder...');
      shell.showItemInFolder(filePath);
    }

    return { success: true };
  } catch (err) {
    const error = (err as Error).message;
    console.error('[Update] Download failed:', error);
    await addLogEntry('error', `[Update] Download fehlgeschlagen: ${error}`);
    return { success: false, error };
  }
});
