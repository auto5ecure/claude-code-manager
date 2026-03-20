import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import * as pty from 'node-pty';
import { whatsAppService, WhatsAppConfig } from './whatsapp-service';

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
    // Exclude lock file from changed files list - it's handled automatically by lock system
    return status.split('\n')
      .map((line) => line.slice(3))
      .filter((file) => file !== LOCK_FILENAME && file !== '.cowork.lock');
  } catch {
    return [];
  }
}

// Smart merge for .deployment.json - keeps local machine-specific fields, takes remote for shared fields
function smartMergeDeploymentConfig(localContent: string, remoteContent: string): string {
  try {
    const local = JSON.parse(localContent);
    const remote = JSON.parse(remoteContent);

    // Fields to keep from LOCAL (machine-specific)
    const localOnlyFields = ['server.sshKeyPath'];

    // Start with remote as base
    const merged = JSON.parse(JSON.stringify(remote));

    // Preserve local-only fields
    for (const fieldPath of localOnlyFields) {
      const parts = fieldPath.split('.');
      let localValue = local;
      let mergedRef = merged;

      // Navigate to the parent object
      for (let i = 0; i < parts.length - 1; i++) {
        if (localValue && localValue[parts[i]]) {
          localValue = localValue[parts[i]];
        }
        if (mergedRef && !mergedRef[parts[i]]) {
          mergedRef[parts[i]] = {};
        }
        if (mergedRef) {
          mergedRef = mergedRef[parts[i]];
        }
      }

      // Set the local value
      const lastPart = parts[parts.length - 1];
      if (localValue && localValue[lastPart] !== undefined && mergedRef) {
        mergedRef[lastPart] = localValue[lastPart];
      }
    }

    return JSON.stringify(merged, null, 2);
  } catch {
    // If parsing fails, return remote content
    return remoteContent;
  }
}

interface ConflictInfo {
  file: string;
  localContent: string;
  remoteContent: string;
}

function gitPull(repoPath: string, remote: string, branch: string): { success: boolean; error?: string; conflicts?: ConflictInfo[] } {
  try {
    // Try pull with --autostash which automatically stashes and restores local changes
    execSync(`git pull --autostash ${remote} ${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message || '';

    // Check if the error is due to local changes (like .deployment.json)
    if (errorMsg.includes('local changes') || errorMsg.includes('would be overwritten')) {
      try {
        // Save local versions of changed files
        const changedFiles = execSync('git diff --name-only', {
          cwd: repoPath,
          encoding: 'utf-8',
        }).trim().split('\n').filter(f => f);

        const localVersions: Record<string, string> = {};
        for (const file of changedFiles) {
          try {
            localVersions[file] = fs.readFileSync(path.join(repoPath, file), 'utf-8');
          } catch { /* file might not exist */ }
        }

        // Stash local changes
        execSync('git stash push -m "auto-stash before pull"', {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Pull the remote changes
        execSync(`git pull ${remote} ${branch}`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Get remote versions
        const remoteVersions: Record<string, string> = {};
        for (const file of changedFiles) {
          try {
            remoteVersions[file] = fs.readFileSync(path.join(repoPath, file), 'utf-8');
          } catch { /* file might not exist */ }
        }

        // Try to restore stash
        try {
          execSync('git stash pop', {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          // Stash pop had conflicts - handle them smartly
          const conflictFiles = execSync('git diff --name-only --diff-filter=U', {
            cwd: repoPath,
            encoding: 'utf-8',
          }).trim().split('\n').filter(f => f);

          const conflicts: ConflictInfo[] = [];

          for (const file of conflictFiles) {
            const localContent = localVersions[file] || '';
            const remoteContent = remoteVersions[file] || '';

            // Smart merge for .deployment.json
            if (file === '.deployment.json') {
              const merged = smartMergeDeploymentConfig(localContent, remoteContent);
              fs.writeFileSync(path.join(repoPath, file), merged, 'utf-8');
              console.log(`[Git] Smart-merged ${file}`);
            } else {
              // For other files, collect conflict info for UI
              conflicts.push({
                file,
                localContent,
                remoteContent,
              });
              // For now, keep local version
              fs.writeFileSync(path.join(repoPath, file), localContent, 'utf-8');
            }
          }

          // Reset and drop stash
          try {
            execSync('git reset HEAD', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
            execSync('git stash drop', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
          } catch { /* ignore */ }

          if (conflicts.length > 0) {
            return { success: true, conflicts };
          }
        }

        return { success: true };
      } catch (stashErr) {
        return { success: false, error: (stashErr as Error).message };
      }
    }

    return { success: false, error: errorMsg };
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

function getConflictFiles(repoPath: string): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Get files with unmerged status (UU, AA, DD)
    return status.split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

function getConflictDetails(repoPath: string): ConflictInfo[] {
  const conflictFiles = getConflictFiles(repoPath);
  const conflicts: ConflictInfo[] = [];

  for (const file of conflictFiles) {
    const filePath = path.join(repoPath, file);
    try {
      // Get the current file content (with conflict markers)
      const content = fs.readFileSync(filePath, 'utf-8');

      // Try to parse out local and remote content from conflict markers
      let localContent = '';
      let remoteContent = '';

      const lines = content.split('\n');
      let inLocal = false;
      let inRemote = false;

      for (const line of lines) {
        if (line.startsWith('<<<<<<<')) {
          inLocal = true;
          continue;
        } else if (line.startsWith('=======')) {
          inLocal = false;
          inRemote = true;
          continue;
        } else if (line.startsWith('>>>>>>>')) {
          inRemote = false;
          continue;
        }

        if (inLocal) {
          localContent += line + '\n';
        } else if (inRemote) {
          remoteContent += line + '\n';
        }
      }

      // If we couldn't parse conflict markers, use git show to get versions
      if (!localContent && !remoteContent) {
        try {
          localContent = execSync(`git show :2:${file}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          localContent = '(Datei nicht verfügbar)';
        }
        try {
          remoteContent = execSync(`git show :3:${file}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          remoteContent = '(Datei nicht verfügbar)';
        }
      }

      conflicts.push({
        file,
        localContent: localContent.trim(),
        remoteContent: remoteContent.trim(),
      });
    } catch {
      conflicts.push({
        file,
        localContent: '(Fehler beim Lesen)',
        remoteContent: '(Fehler beim Lesen)',
      });
    }
  }

  return conflicts;
}

let mainWindow: BrowserWindow | null = null;
const ptyProcesses: Map<string, pty.IPty> = new Map();

// Notification system for Claude Code events
interface TabNotificationState {
  projectName: string;
  buffer: string;
  lastNotification: number;
  isWaiting: boolean;
  runsClaude: boolean;
}

const tabNotificationStates: Map<string, TabNotificationState> = new Map();
const NOTIFICATION_COOLDOWN = 5000; // 5 seconds between notifications
const BUFFER_MAX_LENGTH = 2000; // Max buffer size to prevent memory issues

// Patterns that indicate Claude is waiting for user input
const WAITING_PATTERNS = [
  /Do you want to (?:proceed|continue|allow|accept|run|execute)\?/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /Press Enter to continue/i,
  /Waiting for (?:approval|confirmation|input)/i,
  /Allow this (?:action|tool|operation)\?/i,
  /Approve\?/i,
  /Continue\?/i,
  /Confirm\?/i,
  /Would you like to/i,
  /Should I (?:proceed|continue)/i,
  /Is this okay\?/i,
  /May I\?/i,
];

// Patterns that indicate task completion
const COMPLETED_PATTERNS = [
  /Task completed/i,
  /Done!$/m,
  /Successfully completed/i,
  /Finished processing/i,
  /All done/i,
  /Changes applied/i,
  /Operation complete/i,
];

// Strip ANSI escape codes for pattern matching
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

function sendClaudeNotification(title: string, body: string, tabId: string) {
  const state = tabNotificationStates.get(tabId);
  if (!state) return;

  const now = Date.now();
  if (now - state.lastNotification < NOTIFICATION_COOLDOWN) {
    return; // Debounce
  }

  state.lastNotification = now;

  // Only show notification if app is not focused
  if (!mainWindow?.isFocused()) {
    const notification = new Notification({
      title: `${title} - ${state.projectName}`,
      body: body,
      silent: false,
    });

    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      // Notify renderer to switch to this tab
      mainWindow?.webContents.send('focus-tab', tabId);
    });

    notification.show();
  }

  // Also send to WhatsApp if enabled
  const config = whatsAppService.getConfig();
  if (config.enabled && whatsAppService.isReady()) {
    whatsAppService.sendNotification(`[${state.projectName}] ${title}: ${body}`);
  }
}

function checkForNotificationPatterns(tabId: string, newData: string) {
  const state = tabNotificationStates.get(tabId);
  if (!state || !state.runsClaude) return;

  // Add new data to buffer
  state.buffer += newData;

  // Trim buffer if too long (keep last part)
  if (state.buffer.length > BUFFER_MAX_LENGTH) {
    state.buffer = state.buffer.slice(-BUFFER_MAX_LENGTH);
  }

  const cleanBuffer = stripAnsi(state.buffer);

  // Check for waiting patterns
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(cleanBuffer)) {
      if (!state.isWaiting) {
        state.isWaiting = true;
        sendClaudeNotification('Wartet auf Eingabe', 'Claude benötigt deine Bestätigung', tabId);
      }
      return;
    }
  }

  // Reset waiting state if no waiting pattern found
  if (state.isWaiting) {
    state.isWaiting = false;
  }

  // Check for completion patterns
  for (const pattern of COMPLETED_PATTERNS) {
    if (pattern.test(cleanBuffer)) {
      sendClaudeNotification('Task abgeschlossen', 'Claude hat die Aufgabe beendet', tabId);
      // Clear buffer after completion notification
      state.buffer = '';
      return;
    }
  }
}

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

  // Set main window for WhatsApp service
  whatsAppService.setMainWindow(mainWindow);
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

  // Clean up old notification state
  tabNotificationStates.delete(tabId);

  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  const projectName = path.basename(cwd);

  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: cwd,
    env: process.env as { [key: string]: string },
  });

  ptyProcesses.set(tabId, ptyProcess);

  // Initialize notification state for Claude tabs
  if (runClaude) {
    tabNotificationStates.set(tabId, {
      projectName,
      buffer: '',
      lastNotification: 0,
      isWaiting: false,
      runsClaude: true,
    });
  }

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send('pty-data', tabId, data);
    // Check for notification patterns if this is a Claude tab
    checkForNotificationPatterns(tabId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
    tabNotificationStates.delete(tabId);
  });

  if (runClaude) {
    setTimeout(() => {
      const initPrompt = 'Lies .env und alle MD-Dateien (CLAUDE.md, CONTEXT.md, DECISIONS.md, STATUS.md) und den tasks/ Ordner falls vorhanden. Analysiere das Projekt kurz.';
      const claudeCmd = autoAccept
        ? `claude --dangerously-skip-permissions '${initPrompt}'\r`
        : `claude '${initPrompt}'\r`;
      ptyProcess.write(claudeCmd);
    }, 500);
    const logMsg = autoAccept ? 'Claude gestartet (unleashed)' : 'Claude gestartet';
    await addLogEntry('command', logMsg, projectName);
  } else {
    await addLogEntry('activity', 'Terminal geöffnet', projectName);
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
  unleashed?: boolean;
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
  const conflictFiles = conflicts ? getConflictFiles(localPath) : [];

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
    conflictFiles,
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

ipcMain.handle('update-cowork-repo-unleashed', async (_event, repoId: string, unleashed: boolean) => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  if (repo) {
    repo.unleashed = unleashed;
    await saveCoworkConfig(config);
  }
  return { success: true };
});

// Get conflict details for merge conflict resolution
ipcMain.handle('get-conflict-details', async (_event, repoPath: string) => {
  try {
    const conflicts = getConflictDetails(repoPath);
    return { success: true, conflicts };
  } catch (err) {
    return { success: false, error: (err as Error).message, conflicts: [] };
  }
});

// Resolve a merge conflict by writing the chosen content
ipcMain.handle('resolve-conflict', async (_event, repoPath: string, filePath: string, content: string) => {
  try {
    const fullPath = path.join(repoPath, filePath);
    await fs.promises.writeFile(fullPath, content, 'utf-8');
    await addLogEntry('activity', `Konflikt gelöst: ${filePath}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Open a file in the default editor
ipcMain.handle('open-in-editor', async (_event, filePath: string) => {
  try {
    // Try VS Code first, then fall back to system default
    try {
      execSync(`code "${filePath}"`, { stdio: 'ignore' });
    } catch {
      // Fall back to system default
      const { shell } = require('electron');
      await shell.openPath(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
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

ipcMain.handle('check-cowork-lock', async (_event, repoPath: string, remote?: string, branch?: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);

  // Fetch latest lock state from remote (if remote/branch provided)
  if (remote && branch) {
    try {
      // Fetch the specific lock file from remote without full pull
      execSync(`git fetch ${remote} ${branch}`, {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      // Try to checkout just the lock file from remote (if it exists)
      try {
        execSync(`git checkout ${remote}/${branch} -- ${LOCK_FILENAME}`, {
          cwd: repoPath,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch {
        // Lock file doesn't exist in remote - remove local if exists
        try {
          await fs.promises.unlink(lockPath);
        } catch {}
      }
    } catch (err) {
      console.log('[Lock] Failed to fetch remote lock state:', (err as Error).message);
    }
  }

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
    // First pull to get latest state (use gitPull which handles stashing)
    const pullResult = gitPull(repoPath, remote, branch);
    if (!pullResult.success) {
      return { success: false, error: pullResult.error };
    }

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

// Find a valid SSH key - tries the specified path first, then common locations
function findSshKey(specifiedPath?: string): string | null {
  const homeDir = os.homedir();

  // List of paths to try
  const pathsToTry: string[] = [];

  // If a path is specified, try it first (with ~ expansion)
  if (specifiedPath) {
    pathsToTry.push(specifiedPath.replace('~', homeDir));
  }

  // Common SSH key locations
  const commonKeys = [
    '~/.ssh/id_ed25519',
    '~/.ssh/id_rsa',
    '~/.ssh/id_ecdsa',
    '~/.ssh/dgk_deploy',
    '~/.ssh/deploy',
  ];

  for (const keyPath of commonKeys) {
    pathsToTry.push(keyPath.replace('~', homeDir));
  }

  // Try each path
  for (const keyPath of pathsToTry) {
    try {
      fs.accessSync(keyPath, fs.constants.R_OK);
      console.log(`[SSH] Found key: ${keyPath}`);
      return keyPath;
    } catch {
      // Key doesn't exist or not readable
    }
  }

  console.log('[SSH] No valid SSH key found');
  return null;
}

// SSH command helper
function sshExec(host: string, user: string, command: string, sshKeyPath?: string, timeoutMs: number = 30000): { success: boolean; output: string; error?: string } {
  try {
    // Find a valid SSH key
    const keyPath = findSshKey(sshKeyPath);
    const keyArg = keyPath ? `-i "${keyPath}"` : '';

    if (!keyPath && sshKeyPath) {
      console.log(`[SSH] Warning: Specified key ${sshKeyPath} not found, trying without key`);
    }

    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${keyArg} ${user}@${host} "${command.replace(/"/g, '\\"')}"`;
    const output = execSync(sshCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    const error = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    // Capture both stdout and stderr for better error messages
    const stderr = error.stderr ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString() : error.stderr) : '';
    const stdout = error.stdout ? (Buffer.isBuffer(error.stdout) ? error.stdout.toString() : error.stdout) : '';
    const errorMsg = stdout || stderr || error.message || 'SSH command failed';

    // Add helpful message if key not found
    if (errorMsg.includes('Permission denied') || errorMsg.includes('not accessible')) {
      const keyPath = findSshKey(sshKeyPath);
      if (!keyPath) {
        return {
          success: false,
          output: '',
          error: `SSH-Key nicht gefunden. Bitte erstelle einen SSH-Key:\n\nssh-keygen -t ed25519\n\noder kopiere einen bestehenden Key nach ~/.ssh/`
        };
      }
    }

    // Filter out Docker deprecation warnings that aren't real errors
    let filteredError = errorMsg;
    if (filteredError.includes('DEPRECATED: The legacy builder is deprecated')) {
      // Extract lines after the deprecation warning
      const lines = filteredError.split('\n').filter(line =>
        !line.includes('DEPRECATED') &&
        !line.includes('BuildKit') &&
        line.trim() !== ''
      );
      if (lines.length === 0) {
        // Only deprecation warning, treat as success
        return { success: true, output: errorMsg, error: undefined };
      }
      filteredError = lines.join('\n');
    }
    return { success: false, output: '', error: filteredError };
  }
}

// SCP helper
function scpUpload(localPath: string, host: string, user: string, remotePath: string, sshKeyPath?: string): { success: boolean; error?: string } {
  try {
    // Find a valid SSH key
    const keyPath = findSshKey(sshKeyPath);
    const keyArg = keyPath ? `-i "${keyPath}"` : '';

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

    // Step 5: Build Docker image on server (5 min timeout for build)
    updateStep('build', 'running');
    const buildResult = sshExec(
      server.host,
      server.user,
      `cd ${server.directory} && rm -rf src && mkdir -p src && tar -xzf deploy.tar.gz -C src 2>/dev/null && docker build -t ${docker.imageName}:latest -f src/${docker.dockerfile} src/ 2>&1 && rm deploy.tar.gz`,
      server.sshKeyPath,
      300000
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

// Import SSH private key
ipcMain.handle('import-ssh-key', async (): Promise<{ success: boolean; keyPath?: string; error?: string }> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'showHiddenFiles'],
    title: 'SSH Private Key importieren',
    defaultPath: path.join(os.homedir(), '.ssh'),
    filters: [
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false };
  }

  const sourcePath = result.filePaths[0];
  const keyName = path.basename(sourcePath);
  const sshDir = path.join(os.homedir(), '.ssh');
  const targetPath = path.join(sshDir, keyName);

  try {
    // Ensure .ssh directory exists
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700 });
    }

    // Read the key content
    const keyContent = fs.readFileSync(sourcePath, 'utf-8');

    // Validate it looks like an SSH key
    if (!keyContent.includes('PRIVATE KEY')) {
      return { success: false, error: 'Die Datei scheint kein SSH Private Key zu sein' };
    }

    // If source is not in .ssh, copy it there
    if (sourcePath !== targetPath) {
      fs.writeFileSync(targetPath, keyContent, { mode: 0o600 });
    }

    // Ensure correct permissions
    fs.chmodSync(targetPath, 0o600);

    return { success: true, keyPath: targetPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Save SSH private key from text input
ipcMain.handle('save-ssh-key', async (_event, keyContent: string, keyName: string): Promise<{ success: boolean; keyPath?: string; error?: string }> => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const targetPath = path.join(sshDir, keyName);

  try {
    // Validate it looks like an SSH key
    if (!keyContent.includes('PRIVATE KEY')) {
      return { success: false, error: 'Der Text scheint kein SSH Private Key zu sein' };
    }

    // Ensure .ssh directory exists
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700 });
    }

    // Write the key file with correct permissions
    fs.writeFileSync(targetPath, keyContent.trim() + '\n', { mode: 0o600 });

    return { success: true, keyPath: targetPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
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

// Generic file dialog handlers
ipcMain.handle('show-open-dialog', async (_event, options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: options.title,
    filters: options.filters,
    properties: (options.properties as any) || ['openFile'],
  });
  return { filePaths: result.filePaths };
});

ipcMain.handle('show-save-dialog', async (_event, options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return { filePath: result.canceled ? undefined : result.filePath };
});

ipcMain.handle('read-file', async (_event, filePath: string): Promise<string> => {
  return await fs.promises.readFile(filePath, 'utf-8');
});

ipcMain.handle('write-file', async (_event, filePath: string, content: string): Promise<void> => {
  await fs.promises.writeFile(filePath, content, 'utf-8');
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
  exeUrl?: string;  // Windows installer
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
    const timeoutMs = 15000; // 15 second timeout

    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.error('[Update] Request timeout after', timeoutMs, 'ms');
          resolve(null);
        }
      }, timeoutMs);

      const req = https.get(url, {
        headers: {
          'User-Agent': 'Claude-MC-Updater',
          'Authorization': `Basic ${auth}`
        },
        timeout: timeoutMs
      }, (res) => {
        console.log('[Update] Response status:', res.statusCode);

        if (res.statusCode !== 200) {
          console.error('[Update] HTTP error:', res.statusCode);
          clearTimeout(timeout);
          if (!resolved) { resolved = true; resolve(null); }
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          if (resolved) return;
          resolved = true;
          try {
            const parsed = JSON.parse(data);
            console.log('[Update] Parsed version info:', parsed);
            resolve(parsed);
          } catch (e) {
            console.error('[Update] Failed to parse JSON:', e, 'Data:', data.substring(0, 200));
            resolve(null);
          }
        });
      });

      req.on('timeout', () => {
        console.error('[Update] Socket timeout');
        req.destroy();
        clearTimeout(timeout);
        if (!resolved) { resolved = true; resolve(null); }
      });

      req.on('error', (e) => {
        console.error('[Update] Request error:', e);
        clearTimeout(timeout);
        if (!resolved) { resolved = true; resolve(null); }
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

    // Determine download URL based on platform
    let downloadUrl: string;
    let fileName: string;

    if (process.platform === 'darwin') {
      downloadUrl = updateInfo.dmgUrl;
      fileName = `Claude-MC-${updateInfo.version}.dmg`;
    } else if (process.platform === 'win32') {
      // Windows: Use exeUrl if available, otherwise construct from dmgUrl
      downloadUrl = updateInfo.exeUrl || updateInfo.dmgUrl.replace('arm64.dmg', 'x64-Setup.exe');
      fileName = `Claude-MC-${updateInfo.version}-Setup.exe`;
    } else {
      downloadUrl = updateInfo.zipUrl;
      fileName = `Claude-MC-${updateInfo.version}.zip`;
    }

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
    const filePath = path.join(tempDir, fileName);

    console.log('[Update] Saving to:', filePath);
    await addLogEntry('activity', `[Update] Lade v${updateInfo.version} herunter nach: ${filePath}`);

    // Download with progress (using Basic Auth for WebDAV)
    const auth = Buffer.from(`${UPDATE_SHARE_TOKEN}:`).toString('base64');
    const downloadTimeoutMs = 300000; // 5 minute timeout for download

    await new Promise<void>((resolve, reject) => {
      let rejected = false;

      const timeout = setTimeout(() => {
        if (!rejected) {
          rejected = true;
          reject(new Error('Download Timeout nach 5 Minuten'));
        }
      }, downloadTimeoutMs);

      const req = https.get(downloadUrl, {
        headers: {
          'User-Agent': 'Claude-MC-Updater',
          'Authorization': `Basic ${auth}`
        },
        timeout: 30000 // 30 second connection timeout
      }, (res) => {
        console.log('[Update] Download response status:', res.statusCode);

        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          rejected = true;
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
            try {
              if (!event.sender.isDestroyed()) {
                event.sender.send('update-progress', progress);
              }
            } catch {
              // Window was destroyed, ignore
            }
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          clearTimeout(timeout);
          fileStream.close();
          if (!rejected) resolve();
        });

        fileStream.on('error', (err) => {
          clearTimeout(timeout);
          fs.unlink(filePath, () => {});
          if (!rejected) { rejected = true; reject(err); }
        });
      });

      req.on('timeout', () => {
        console.error('[Update] Download socket timeout');
        req.destroy();
        clearTimeout(timeout);
        if (!rejected) { rejected = true; reject(new Error('Download Verbindungs-Timeout')); }
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        if (!rejected) { rejected = true; reject(err); }
      });
    });

    console.log('[Update] Download complete:', filePath);
    await addLogEntry('activity', `[Update] Download abgeschlossen: ${filePath}`);

    // Auto-install the update
    if (process.platform === 'darwin') {
      console.log('[Update] Auto-installing on macOS...');
      await addLogEntry('activity', '[Update] Starte Auto-Installation...');

      try {
        // 1. Mount the DMG
        console.log('[Update] Mounting DMG...');
        await addLogEntry('activity', '[Update] Mounte DMG...');
        const mountOutput = execSync(`hdiutil attach "${filePath}" -nobrowse -noverify -noautoopen`, {
          encoding: 'utf-8',
        });

        // Parse mount point from output (last column of last line with /Volumes)
        const mountLine = mountOutput.split('\n').find(line => line.includes('/Volumes/'));
        if (!mountLine) {
          throw new Error('DMG mount point not found');
        }
        const mountPoint = mountLine.substring(mountLine.indexOf('/Volumes/')).trim();
        console.log('[Update] Mounted at:', mountPoint);
        await addLogEntry('activity', `[Update] Gemountet: ${mountPoint}`);

        // 2. Find the .app in the mounted volume
        const appFiles = fs.readdirSync(mountPoint).filter(f => f.endsWith('.app'));
        if (appFiles.length === 0) {
          throw new Error('No .app found in DMG');
        }
        const appName = appFiles[0];
        const sourceApp = path.join(mountPoint, appName);
        const targetApp = `/Applications/${appName}`;

        console.log('[Update] Source:', sourceApp);
        console.log('[Update] Target:', targetApp);
        await addLogEntry('activity', `[Update] Kopiere ${appName} nach /Applications...`);

        // 3. Remove old app and copy new one
        // Use rm -rf and cp -R to handle the app bundle properly
        execSync(`rm -rf "${targetApp}"`, { encoding: 'utf-8' });
        execSync(`cp -R "${sourceApp}" "${targetApp}"`, { encoding: 'utf-8' });

        // Remove quarantine attribute to prevent Gatekeeper blocking
        try {
          execSync(`xattr -rd com.apple.quarantine "${targetApp}"`, { encoding: 'utf-8' });
          console.log('[Update] Quarantine attribute removed');
        } catch {
          console.log('[Update] No quarantine attribute to remove');
        }

        console.log('[Update] App copied successfully');
        await addLogEntry('activity', '[Update] App kopiert!');

        // 4. Unmount DMG
        console.log('[Update] Unmounting DMG...');
        execSync(`hdiutil detach "${mountPoint}" -quiet`, { encoding: 'utf-8' });
        await addLogEntry('activity', '[Update] DMG ausgeworfen');

        // 5. Remove downloaded DMG
        fs.unlinkSync(filePath);

        // 6. Relaunch the app
        console.log('[Update] Relaunching app...');
        await addLogEntry('activity', '[Update] Starte App neu...');

        // Use shell command with nohup and sleep to ensure it runs independently
        const { exec } = await import('child_process');

        // Create a completely detached shell process that will:
        // 1. Sleep 1 second to let this app quit
        // 2. Open the new app
        // The & at the end makes it run in background, nohup prevents signals
        const relaunchCmd = `(sleep 1 && open -a "${targetApp}") &`;
        exec(relaunchCmd, { shell: '/bin/bash' });

        console.log('[Update] Relaunch command scheduled');
        await addLogEntry('activity', '[Update] Neustart geplant, beende...');

        // Quit immediately - the shell command will launch the new app
        setTimeout(() => {
          console.log('[Update] Quitting old app...');
          app.quit();
        }, 500);

      } catch (installErr) {
        const installError = (installErr as Error).message;
        console.error('[Update] Auto-install failed:', installError);
        await addLogEntry('error', `[Update] Auto-Installation fehlgeschlagen: ${installError}`);

        // Fallback: just open the DMG manually
        console.log('[Update] Fallback: Opening DMG manually...');
        await addLogEntry('activity', '[Update] Fallback: Öffne DMG manuell...');
        shell.openPath(filePath);
        return { success: false, error: `Auto-Installation fehlgeschlagen: ${installError}. DMG wurde geöffnet.` };
      }
    } else if (process.platform === 'win32') {
      // Windows: Run NSIS installer (already downloaded as .exe)
      console.log('[Update] Auto-installing on Windows...');
      await addLogEntry('activity', '[Update] Starte Auto-Installation...');

      try {
        console.log('[Update] Running installer:', filePath);
        await addLogEntry('activity', '[Update] Starte Installer...');

        // Run installer with /S for silent install
        // The installer will handle replacing the old version
        const { exec } = await import('child_process');

        // Start the installer detached, then quit this app
        // /S = silent install
        const installCmd = `start "" "${filePath}" /S`;
        exec(installCmd, { shell: 'cmd.exe' });

        console.log('[Update] Installer started, quitting...');
        await addLogEntry('activity', '[Update] Installer gestartet, beende App...');

        // Quit after a short delay to let the installer start
        setTimeout(() => {
          console.log('[Update] Quitting for Windows update...');
          app.quit();
        }, 1000);

      } catch (installErr) {
        const installError = (installErr as Error).message;
        console.error('[Update] Windows auto-install failed:', installError);
        await addLogEntry('error', `[Update] Auto-Installation fehlgeschlagen: ${installError}`);

        // Fallback: open the downloaded file
        shell.openPath(filePath);
        return { success: false, error: `Auto-Installation fehlgeschlagen: ${installError}` };
      }
    } else {
      // Linux or other: Open containing folder
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

// ============================================
// WhatsApp Integration
// ============================================

// Track active WhatsApp-Claude sessions
const whatsAppClaudeSessions: Map<string, {
  tabId: string;
  responseBuffer: string;
  lastActivity: number;
  claudeStarted?: boolean;
  sendTimeout?: NodeJS.Timeout | null;
  projectPath?: string;
  projectName?: string;
}> = new Map();

// Initialize WhatsApp
ipcMain.handle('whatsapp-init', async () => {
  try {
    await whatsAppService.initialize();
    await addLogEntry('activity', 'WhatsApp initialisiert');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// Get WhatsApp status
ipcMain.handle('whatsapp-status', async () => {
  return whatsAppService.getStatus();
});

// Get WhatsApp config
ipcMain.handle('whatsapp-get-config', async () => {
  return whatsAppService.getConfig();
});

// Save WhatsApp config
ipcMain.handle('whatsapp-save-config', async (_event, config: Partial<WhatsAppConfig>) => {
  await whatsAppService.saveConfig(config);
  return { success: true };
});

// Send WhatsApp message
ipcMain.handle('whatsapp-send', async (_event, to: string, message: string) => {
  const success = await whatsAppService.sendMessage(to, message);
  return { success };
});

// Disconnect WhatsApp
ipcMain.handle('whatsapp-disconnect', async () => {
  await whatsAppService.disconnect();
  await addLogEntry('activity', 'WhatsApp getrennt');
  return { success: true };
});

// Logout WhatsApp (clear session)
ipcMain.handle('whatsapp-logout', async () => {
  await whatsAppService.logout();
  await addLogEntry('activity', 'WhatsApp abgemeldet');
  return { success: true };
});

// Check WhatsApp/Chrome permissions
ipcMain.handle('whatsapp-check-permissions', async () => {
  return whatsAppService.checkPermissions();
});

// Open external URL
ipcMain.handle('open-external', async (_event, url: string) => {
  const { shell } = await import('electron');
  await shell.openExternal(url);
});

// Start a WhatsApp Claude session for a project (internal function)
async function startWhatsAppClaudeSession(senderNumber: string, projectPath: string, unleashed: boolean = false): Promise<{ success: boolean; tabId?: string; error?: string }> {
  // Verify project exists
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: `Projekt nicht gefunden: ${projectPath}` };
  }

  // Close existing session if any
  const existingSession = whatsAppClaudeSessions.get(senderNumber);
  if (existingSession) {
    const existingPty = ptyProcesses.get(existingSession.tabId);
    if (existingPty) {
      existingPty.kill();
      ptyProcesses.delete(existingSession.tabId);
    }
    whatsAppClaudeSessions.delete(senderNumber);
  }

  const tabId = `whatsapp-${senderNumber}-${Date.now()}`;
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  const projectName = path.basename(projectPath);

  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: projectPath,
    env: process.env as { [key: string]: string },
  });

  ptyProcesses.set(tabId, ptyProcess);
  setupWhatsAppResponseCapture(tabId, senderNumber);

  // Store project path in session
  const session = whatsAppClaudeSessions.get(senderNumber);
  if (session) {
    (session as any).projectPath = projectPath;
    (session as any).projectName = projectName;
  }

  ptyProcess.onData((data) => {
    mainWindow?.webContents.send('pty-data', tabId, data);
    captureClaudeResponseForWhatsApp(tabId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
    whatsAppClaudeSessions.delete(senderNumber);
  });

  // Start Claude with optional unleashed mode
  setTimeout(() => {
    const unleashedFlag = unleashed ? ' --dangerously-skip-permissions' : '';
    ptyProcess.write(`claude${unleashedFlag}\r`);
  }, 500);

  await addLogEntry('activity', `WhatsApp Session: ${projectName}${unleashed ? ' (unleashed)' : ''}`);

  // Notify UI about new WhatsApp session
  mainWindow?.webContents.send('whatsapp-session-started', {
    tabId,
    senderNumber,
    projectPath,
    projectName,
    unleashed
  });

  return { success: true, tabId };
}

// Handle incoming WhatsApp messages -> forward to Claude
whatsAppService.onMessage(async (from, body, _message) => {
  const config = whatsAppService.getConfig();

  // Check if auto-reply is enabled
  if (!config.autoReply) {
    console.log('WhatsApp auto-reply disabled, ignoring message');
    return;
  }

  const trimmedBody = body.trim();

  // Handle commands
  if (trimmedBody.startsWith('/')) {
    const parts = trimmedBody.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (command) {
      case '/projekt':
      case '/project':
      case '/start': {
        if (!args) {
          // List available projects
          const projectConfig = await loadProjectConfig();
          const projectList = projectConfig.projects.map((p: { path: string }, i: number) => `${i + 1}. ${path.basename(p.path)}`).join('\n');
          await whatsAppService.sendMessage(from,
            `Verfügbare Projekte:\n${projectList}\n\nNutze: /projekt <Name oder Nummer>`
          );
          return;
        }

        // Find project by name or number
        const projectConfig = await loadProjectConfig();
        let projectPath: string | undefined;

        const projectNum = parseInt(args);
        if (!isNaN(projectNum) && projectNum > 0 && projectNum <= projectConfig.projects.length) {
          projectPath = projectConfig.projects[projectNum - 1].path;
        } else {
          // Search by name (partial match)
          const searchTerm = args.toLowerCase();
          const found = projectConfig.projects.find((p: { path: string }) =>
            path.basename(p.path).toLowerCase().includes(searchTerm) ||
            p.path.toLowerCase().includes(searchTerm)
          );
          if (found) projectPath = found.path;
        }

        if (!projectPath) {
          await whatsAppService.sendMessage(from, `Projekt "${args}" nicht gefunden. Nutze /projekt für Liste.`);
          return;
        }

        const result = await startWhatsAppClaudeSession(from, projectPath, false);
        if (result.success) {
          await whatsAppService.sendMessage(from, `Claude gestartet für: ${path.basename(projectPath)}\n\nDu kannst jetzt Nachrichten senden.`);
        } else {
          await whatsAppService.sendMessage(from, `Fehler: ${result.error}`);
        }
        return;
      }

      case '/unleashed': {
        // Start with --dangerously-skip-permissions
        if (!args) {
          await whatsAppService.sendMessage(from, 'Nutze: /unleashed <Projektname oder Nummer>');
          return;
        }

        const projectConfig2 = await loadProjectConfig();
        let projectPath: string | undefined;

        const projectNum = parseInt(args);
        if (!isNaN(projectNum) && projectNum > 0 && projectNum <= projectConfig2.projects.length) {
          projectPath = projectConfig2.projects[projectNum - 1].path;
        } else {
          const searchTerm = args.toLowerCase();
          const found = projectConfig2.projects.find((p: { path: string }) =>
            path.basename(p.path).toLowerCase().includes(searchTerm)
          );
          if (found) projectPath = found.path;
        }

        if (!projectPath) {
          await whatsAppService.sendMessage(from, `Projekt "${args}" nicht gefunden.`);
          return;
        }

        const result = await startWhatsAppClaudeSession(from, projectPath, true);
        if (result.success) {
          await whatsAppService.sendMessage(from, `Claude UNLEASHED gestartet für: ${path.basename(projectPath)}\n\n⚠️ Auto-Accept aktiv!`);
        } else {
          await whatsAppService.sendMessage(from, `Fehler: ${result.error}`);
        }
        return;
      }

      case '/stop':
      case '/ende':
      case '/quit': {
        const session = whatsAppClaudeSessions.get(from);
        if (session) {
          const ptyProcess = ptyProcesses.get(session.tabId);
          if (ptyProcess) {
            ptyProcess.write('\x03'); // Ctrl+C
            setTimeout(() => {
              ptyProcess.write('exit\r');
            }, 500);
          }
          await whatsAppService.sendMessage(from, 'Session beendet.');
        } else {
          await whatsAppService.sendMessage(from, 'Keine aktive Session.');
        }
        return;
      }

      case '/status': {
        const session = whatsAppClaudeSessions.get(from);
        if (session) {
          const projectName = (session as any).projectName || 'Unbekannt';
          await whatsAppService.sendMessage(from, `Aktive Session: ${projectName}`);
        } else {
          await whatsAppService.sendMessage(from, 'Keine aktive Session. Nutze /projekt um zu starten.');
        }
        return;
      }

      case '/projekte':
      case '/list':
      case '/help':
      case '/hilfe': {
        const projectConfig3 = await loadProjectConfig();
        const projectList = projectConfig3.projects.map((p: { path: string }, i: number) => `${i + 1}. ${path.basename(p.path)}`).join('\n');
        const session = whatsAppClaudeSessions.get(from);
        const statusText = session ? `\n\nAktiv: ${(session as any).projectName || 'Ja'}` : '';

        await whatsAppService.sendMessage(from,
          `WhatsApp Claude Befehle:\n\n` +
          `/projekt <Name> - Session starten\n` +
          `/unleashed <Name> - Mit Auto-Accept\n` +
          `/stop - Session beenden\n` +
          `/status - Aktive Session\n` +
          `/projekte - Diese Liste\n\n` +
          `Projekte:\n${projectList}${statusText}`
        );
        return;
      }

      default:
        // Unknown command, treat as message if session exists
        break;
    }
  }

  // Find existing Claude session for this sender
  const session = whatsAppClaudeSessions.get(from);

  if (!session) {
    // No active session - send help
    console.log(`WhatsApp message from ${from}, no active session`);
    await addLogEntry('activity', `WhatsApp von ${from}: ${body.substring(0, 50)}...`);

    await whatsAppService.sendMessage(from,
      `Keine aktive Session.\n\nNutze /projekt <Name> um zu starten, oder /hilfe für alle Befehle.`
    );

    // Also notify UI
    mainWindow?.webContents.send('whatsapp-message', { from, body });
    return;
  }

  // Write to the PTY for this session
  const ptyProcess = ptyProcesses.get(session.tabId);
  if (ptyProcess) {
    // Send the message to Claude
    ptyProcess.write(body + '\r');
    session.lastActivity = Date.now();
    await addLogEntry('command', `WhatsApp -> Claude: ${body.substring(0, 50)}...`);
  }
});

// Forward Claude responses to WhatsApp when in WhatsApp mode
function setupWhatsAppResponseCapture(tabId: string, senderNumber: string) {
  whatsAppClaudeSessions.set(senderNumber, {
    tabId,
    responseBuffer: '',
    lastActivity: Date.now(),
    claudeStarted: false,    // Track if Claude REPL has started
    sendTimeout: null as NodeJS.Timeout | null,  // Debounce timer
  });
}

function captureClaudeResponseForWhatsApp(tabId: string, data: string) {
  // Find session by tabId
  for (const [number, session] of whatsAppClaudeSessions.entries()) {
    if (session.tabId === tabId) {
      const extSession = session as any;

      // Check if Claude has started (look for Claude's greeting or prompt)
      if (!extSession.claudeStarted) {
        // Claude typically shows a greeting or waits for input with a special prompt
        if (data.includes('Claude') || data.includes('>') || data.includes('How can I help')) {
          extSession.claudeStarted = true;
          session.responseBuffer = ''; // Clear any startup noise
        }
        // Don't process data until Claude is ready
        return;
      }

      // Add to buffer
      session.responseBuffer += data;
      session.lastActivity = Date.now();

      // Clear existing timeout
      if (extSession.sendTimeout) {
        clearTimeout(extSession.sendTimeout);
      }

      // Set a debounce timeout - wait 1.5 seconds of no new data before sending
      extSession.sendTimeout = setTimeout(() => {
        sendWhatsAppResponse(number, session);
      }, 1500);

      break;
    }
  }
}

function sendWhatsAppResponse(number: string, session: { tabId: string; responseBuffer: string; lastActivity: number }) {
  // Clean the buffer
  let cleanBuffer = stripAnsi(session.responseBuffer);

  // Filter out terminal noise
  const linesToFilter = [
    /^\s*%\s*$/,                          // Just % prompt
    /^\s*\$\s*$/,                          // Just $ prompt
    /^\(base\).*%/,                        // Conda prompt
    /.*@.*%\s*$/,                          // user@host %
    /.*@.*\$\s*$/,                         // user@host $
    /^\s*claude\s*$/,                      // Just "claude" command
    /^\[.*\d+[a-z]/i,                      // ANSI sequences like [?2004h
    /^\?\d+[a-z]/i,                        // More ANSI
    /^Last login:/,                        // Login message
    /^\s*$/,                               // Empty lines
    /^>\s*$/,                              // Just > prompt
    /^─+$/,                                // Horizontal lines
    /^\s*\d+\s*$/,                         // Just numbers (like token counts)
  ];

  // Split into lines and filter
  const lines = cleanBuffer.split('\n');
  const filteredLines = lines.filter(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return false;

    // Filter out lines matching noise patterns
    for (const pattern of linesToFilter) {
      if (pattern.test(trimmedLine)) return false;
    }

    // Filter out very short lines that are likely prompts
    if (trimmedLine.length < 3) return false;

    // Filter out lines that look like shell prompts
    if (/^[\w\-]+\s*%\s*$/.test(trimmedLine)) return false;
    if (/^[\w\-]+\s*\$\s*$/.test(trimmedLine)) return false;

    return true;
  });

  const responseText = filteredLines.join('\n').trim();

  // Only send if we have meaningful content
  if (responseText.length > 10) {
    if (responseText.length < 4000) {
      whatsAppService.sendMessage(number, responseText);
    } else {
      // Split long messages
      const chunks = responseText.match(/.{1,3900}/gs) || [];
      for (const chunk of chunks) {
        whatsAppService.sendMessage(number, chunk);
      }
    }
  }

  session.responseBuffer = '';
}

// Clean up old WhatsApp sessions (older than 30 minutes)
setInterval(() => {
  const now = Date.now();
  const timeout = 30 * 60 * 1000; // 30 minutes

  for (const [number, session] of whatsAppClaudeSessions.entries()) {
    if (now - session.lastActivity > timeout) {
      console.log(`Cleaning up WhatsApp session for ${number}`);
      whatsAppClaudeSessions.delete(number);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Start WhatsApp Claude session from UI
ipcMain.handle('whatsapp-start-claude-session', async (_event, senderNumber: string, projectPath: string, unleashed: boolean = false) => {
  return startWhatsAppClaudeSession(senderNumber, projectPath, unleashed);
});
