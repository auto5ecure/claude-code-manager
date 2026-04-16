import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as tls from 'tls';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import * as pty from 'node-pty';
import { whatsAppService, WhatsAppConfig } from './whatsapp-service';
import { detectVaultPath, updateProjectWiki, getGitChanges, updateCoworkVaultWiki, regenerateFullVaultIndexWithCowork, updateCoworkVaultIndexEntry, updateProjectVaultIndexEntry, updateVaultWiki } from './wiki-generator';
import type { WikiSettings } from '../shared/types';

// Get app version from package.json
const packageJson = require('../../package.json');
const APP_VERSION = packageJson.version;

// Prevent EPIPE crashes: happens when streaming to a renderer that navigated away
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // silently ignore broken pipe
  console.error('[Main] Uncaught exception:', err);
});

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
    // Try pull with --rebase --autostash to handle divergent branches cleanly
    execSync(`git pull --rebase --autostash ${remote} ${branch}`, {
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
// Output batching: buffer PTY data for 8ms before sending IPC to reduce message frequency
const ptyDataBuffers = new Map<string, string>();
const ptyDataTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Sub-Agents state
interface AgentEntry {
  id: string;
  projectPath: string;
  projectName: string;
  task: string;
  state: 'pending' | 'running' | 'done' | 'error';
  output: string;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  process?: ReturnType<typeof spawn>;
}
const agentMap: Map<string, AgentEntry> = new Map();

// Notification system for Claude Code events
interface TabNotificationState {
  projectName: string;
  projectPath: string;
  projectId: string;
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
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')           // Standard ANSI sequences
    .replace(/\x1B\][^\x07]*\x07/g, '')              // OSC sequences
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')         // Private mode sequences like [?2004h
    .replace(/\[\?[0-9]+[a-zA-Z]/g, '')              // Leftover [?2026h style codes
    .replace(/\x1B[()][AB012]/g, '')                 // Character set selection
    .replace(/\x1B[=>]/g, '')                        // Keypad modes
    .replace(/\r/g, '')                              // Carriage returns
    .replace(/\x07/g, '');                           // Bell character
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

  // Strip ANSI from only the new chunk and append to buffer (avoids re-stripping full buffer each call)
  state.buffer += stripAnsi(newData);

  // Trim buffer if too long (keep last part)
  if (state.buffer.length > BUFFER_MAX_LENGTH) {
    state.buffer = state.buffer.slice(-BUFFER_MAX_LENGTH);
  }

  // Check for waiting patterns
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(state.buffer)) {
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
    if (pattern.test(state.buffer)) {
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
const MC_WIKI_DIR = path.join(os.homedir(), '.claude', 'mc-wiki');
const MEMORY_FILE = path.join(MC_WIKI_DIR, 'memory.md');

interface OrchestratorMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

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

// Create claudemc.md marker file in project root
async function createClaudeMcMarker(projectPath: string, projectName: string, projectType: 'tools' | 'projekt'): Promise<void> {
  const markerPath = path.join(projectPath, 'claudemc.md');
  const projectId = projectPath.replace(/\//g, '-');
  const now = new Date().toISOString();

  const content = `# Claude MC Projekt

> Diese Datei wird von Claude MC verwendet, um das Projekt zu identifizieren.
> Nicht löschen - ermöglicht Wiederherstellung bei Pfadänderungen.

## Metadaten

| Eigenschaft | Wert |
|-------------|------|
| Projekt-ID | \`${projectId}\` |
| Name | ${projectName} |
| Typ | ${projectType === 'tools' ? 'Engineering Toolbox' : 'Staff Engineering'} |
| Registriert | ${now.split('T')[0]} |
| Ursprünglicher Pfad | \`${projectPath}\` |

---
*Generiert von Claude MC*
`;

  try {
    // Only create if doesn't exist (don't overwrite)
    await fs.promises.access(markerPath);
  } catch {
    // File doesn't exist, create it
    await fs.promises.writeFile(markerPath, content, 'utf-8');
  }
}

// Scan for claudemc.md files to find moved projects
async function scanForMovedProjects(searchPaths: string[]): Promise<Array<{ path: string; name: string; type: 'tools' | 'projekt'; originalPath: string }>> {
  const found: Array<{ path: string; name: string; type: 'tools' | 'projekt'; originalPath: string }> = [];

  for (const searchPath of searchPaths) {
    try {
      const entries = await fs.promises.readdir(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectPath = path.join(searchPath, entry.name);
          const markerPath = path.join(projectPath, 'claudemc.md');

          try {
            const content = await fs.promises.readFile(markerPath, 'utf-8');
            // Parse marker file
            const typeMatch = content.match(/Typ \| (Engineering Toolbox|Staff Engineering)/);
            const originalPathMatch = content.match(/Ursprünglicher Pfad \| `([^`]+)`/);

            if (originalPathMatch) {
              found.push({
                path: projectPath,
                name: entry.name,
                type: typeMatch?.[1] === 'Engineering Toolbox' ? 'tools' : 'projekt',
                originalPath: originalPathMatch[1],
              });
            }
          } catch {
            // No marker file
          }
        }
      }
    } catch {
      // Search path not accessible
    }
  }

  return found;
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
// Apply projekt template to cowork repos that don't have CLAUDE.md
async function applyTemplateToCoworkRepos(): Promise<void> {
  try {
    const config = await loadCoworkConfig();
    for (const repo of config.repositories) {
      const claudeMdPath = path.join(repo.localPath, 'CLAUDE.md');
      try {
        await fs.promises.access(claudeMdPath);
        // CLAUDE.md exists - don't overwrite
      } catch {
        // No CLAUDE.md - create with projekt template
        try {
          const template = getDefaultTemplate('projekt');
          await fs.promises.writeFile(claudeMdPath, template, 'utf-8');
          console.log(`Created CLAUDE.md for cowork repo: ${repo.name}`);
        } catch (err) {
          console.error(`Failed to create CLAUDE.md for ${repo.name}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Failed to apply templates to cowork repos:', err);
  }
}

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

  app.whenReady().then(async () => {
    createWindow();
    // Apply projekt template to cowork repos without CLAUDE.md
    await applyTemplateToCoworkRepos();
  });

  // Auto-release own cowork locks on app quit (prevents stale locks on crash/force-close)
  app.on('before-quit', () => {
    for (const [repoPath, { remote, branch }] of activeLocks.entries()) {
      try {
        const lockPath = path.join(repoPath, LOCK_FILENAME);
        fs.rmSync(lockPath, { force: true });
        execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
        execSync(`git commit -m "🔓 Unlock: ${getUsername()}@${getMachineName()} (app closed)"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
        try {
          execSync(`git pull --rebase --autostash ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
        } catch { /* ignore – push may still succeed */ }
        execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
        activeLocks.delete(repoPath);
      } catch { /* best-effort – don't block quit */ }
    }
  });

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
    // Check if project path exists
    let exists = true;
    try {
      await fs.promises.access(p.path);
    } catch {
      exists = false;
    }

    let hasClaudeMd = false;
    if (exists) {
      try {
        await fs.promises.access(path.join(p.path, 'CLAUDE.md'));
        hasClaudeMd = true;
      } catch {
        // No CLAUDE.md
      }
    }

    const gitBranch = exists ? getGitBranch(p.path) : undefined;
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
      exists,
    });
  }

  return projects;
});

// Scan for moved projects and repair paths
ipcMain.handle('scan-moved-projects', async (_event, searchPaths: string[]) => {
  const config = await loadProjectConfig();
  const movedProjects: Array<{ oldPath: string; newPath: string; name: string }> = [];

  // Check which projects are missing
  const missingProjects = [];
  for (const p of config.projects) {
    try {
      await fs.promises.access(p.path);
    } catch {
      missingProjects.push(p);
    }
  }

  if (missingProjects.length === 0) {
    return { found: [], repaired: 0 };
  }

  // Scan for claudemc.md files
  const foundProjects = await scanForMovedProjects(searchPaths);

  // Match found projects with missing ones
  for (const found of foundProjects) {
    const missing = missingProjects.find(m => m.path === found.originalPath);
    if (missing && found.path !== found.originalPath) {
      // Update the project path
      missing.path = found.path;
      movedProjects.push({
        oldPath: found.originalPath,
        newPath: found.path,
        name: found.name,
      });
    }
  }

  // Save updated config
  if (movedProjects.length > 0) {
    await saveProjectConfig(config);
    await addLogEntry('activity', `${movedProjects.length} verschobene Projekte gefunden und repariert`);
  }

  return { found: movedProjects, repaired: movedProjects.length };
});

// Check for missing projects at startup
ipcMain.handle('check-missing-projects', async () => {
  const config = await loadProjectConfig();
  const missing: Array<{ path: string; name: string }> = [];

  for (const p of config.projects) {
    try {
      await fs.promises.access(p.path);
    } catch {
      missing.push({ path: p.path, name: p.name || path.basename(p.path) });
    }
  }

  return missing;
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

  // Create claudemc.md marker file
  await createClaudeMcMarker(projectPath, newProject.name, type);

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

  // Create claudemc.md marker file
  await createClaudeMcMarker(projectPath, newProject.name, 'projekt');

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

  // Create claudemc.md marker file
  await createClaudeMcMarker(projectPath, newProject.name, 'projekt');

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

ipcMain.handle('update-project-path', async (_event, oldPath: string, newPath: string) => {
  // Verify new path exists
  try {
    const stat = await fs.promises.stat(newPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Pfad ist kein Ordner' };
    }
  } catch {
    return { success: false, error: 'Pfad existiert nicht' };
  }

  const config = await loadProjectConfig();
  const project = config.projects.find((p) => p.path === oldPath);
  if (project) {
    project.path = newPath;
    await saveProjectConfig(config);
    await addLogEntry('activity', `Projektpfad aktualisiert: ${project.name}`, project.name);
    return { success: true };
  }
  return { success: false, error: 'Projekt nicht gefunden' };
});

ipcMain.handle('select-new-project-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Neuen Projektpfad auswählen',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
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

  // Trigger wiki update on CLAUDE.md save
  const projectId = projectPath.replace(/\//g, '-');
  triggerWikiUpdate(projectPath, projectId).catch(err => {
    console.error('Wiki update failed on CLAUDE.md save:', err);
  });

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

// Wiki Integration IPC Handlers
ipcMain.handle('get-wiki-settings', async (_event, projectId: string): Promise<WikiSettings | null> => {
  try {
    const settingsPath = path.join(CLAUDE_DIR, 'projects', projectId, 'wiki-settings.json');
    const content = await fs.promises.readFile(settingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
});

ipcMain.handle('save-wiki-settings', async (_event, projectId: string, settings: WikiSettings) => {
  const projectDir = path.join(CLAUDE_DIR, 'projects', projectId);
  const settingsPath = path.join(projectDir, 'wiki-settings.json');
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('detect-vault-path', async (_event, projectPath: string): Promise<string | null> => {
  return detectVaultPath(projectPath);
});

ipcMain.handle('update-project-wiki', async (_event, projectPath: string, projectId: string) => {
  try {
    // Get wiki settings
    const settingsPath = path.join(CLAUDE_DIR, 'projects', projectId, 'wiki-settings.json');
    let settings: WikiSettings;
    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      return { success: false, error: 'Wiki nicht aktiviert' };
    }

    // Check if any wiki option is enabled (support both old and new naming)
    const projectEnabled = settings.wikiProjectEnabled ?? settings.createVaultPage ?? settings.enabled ?? false;
    const vaultIndexEnabled = settings.wikiVaultIndexEnabled ?? settings.autoUpdateVaultIndex ?? false;

    if (!projectEnabled && !vaultIndexEnabled) {
      return { success: true, message: 'Keine Wiki-Option aktiviert' };
    }

    // Detect vault path
    const vaultPath = settings.vaultPath || detectVaultPath(projectPath);
    if (!vaultPath) {
      return { success: false, error: 'Kein Obsidian Vault gefunden' };
    }

    // Get project info
    const projectName = path.basename(projectPath);
    let gitBranch: string | undefined;
    let gitDirty = false;
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
      const statusOutput = execSync('git status --porcelain', {
        cwd: projectPath,
        encoding: 'utf-8'
      });
      gitDirty = statusOutput.trim().length > 0;
    } catch {}

    // Get CLAUDE.md content
    let claudeMdContent: string | undefined;
    try {
      claudeMdContent = await fs.promises.readFile(path.join(projectPath, 'CLAUDE.md'), 'utf-8');
    } catch {}

    // Determine project type from stored projects
    let projectType: 'tools' | 'projekt' = 'projekt';
    try {
      const config = await loadProjectConfig();
      const proj = config.projects?.find((p: { path: string }) => p.path === projectPath);
      if (proj?.type) projectType = proj.type;
    } catch {}

    const projectInfo = { name: projectName, path: projectPath, type: projectType, gitBranch, gitDirty, claudeMdContent };
    const results: string[] = [];

    // Update project wiki page if enabled
    if (projectEnabled) {
      const result = await updateVaultWiki(projectInfo, vaultPath);
      if (result.success) {
        results.push('Projekt-Wiki aktualisiert');
      } else {
        return { success: false, error: result.error };
      }
    }

    // Update vault index entry if enabled (only this project's entry)
    if (vaultIndexEnabled) {
      const result = await updateProjectVaultIndexEntry(projectInfo, vaultPath);
      if (result.success) {
        results.push('Vault-Index Eintrag aktualisiert');
      } else {
        return { success: false, error: result.error };
      }
    }

    // Update lastUpdated timestamp
    settings.lastUpdated = new Date().toISOString();
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    return { success: true, message: results.join(', ') };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('regenerate-vault-index', async (_event, vaultPath: string) => {
  try {
    // Load all projects to include them in the index
    const config = await loadProjectConfig();
    const projects = [];

    for (const proj of config.projects) {
      const projectPath = proj.path;
      const projectName = proj.name || path.basename(projectPath);
      const projectType = proj.type || 'projekt';

      let gitBranch: string | undefined;
      let gitDirty = false;

      try {
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: projectPath,
          encoding: 'utf-8'
        }).trim();

        const statusOutput = execSync('git status --porcelain', {
          cwd: projectPath,
          encoding: 'utf-8'
        });
        gitDirty = statusOutput.trim().length > 0;
      } catch {
        // Not a git repo
      }

      projects.push({
        name: projectName,
        path: projectPath,
        type: projectType as 'tools' | 'projekt',
        gitBranch,
        gitDirty
      });
    }

    // Also load cowork repos - filter to only those with wiki enabled for THIS vault
    // Check if wikiVaultPath starts with vaultPath (project wiki can be in subfolder)
    const coworkRepos = await loadCoworkRepositories();
    console.log(`[regenerate-vault-index] vaultPath: ${vaultPath}`);
    console.log(`[regenerate-vault-index] coworkRepos loaded: ${coworkRepos.length}`);
    coworkRepos.forEach(r => {
      console.log(`  - ${r.name}: wikiEnabled=${r.wikiEnabled}, wikiVaultPath=${r.wikiVaultPath}`);
      if (r.wikiEnabled && r.wikiVaultPath) {
        console.log(`    startsWith check: ${r.wikiVaultPath.startsWith(vaultPath)}`);
      }
    });
    const coworkInfos = coworkRepos
      .filter(r => r.wikiEnabled && r.wikiVaultPath && r.wikiVaultPath.startsWith(vaultPath))
      .map(r => ({
        name: r.name,
        path: r.localPath,
        githubUrl: r.githubUrl,
        remote: r.remote,
        branch: r.branch,
        lastSync: r.lastSync
      }));
    console.log(`[regenerate-vault-index] coworkInfos after filter: ${coworkInfos.length}`);
    coworkInfos.forEach(r => console.log(`  - ${r.name}`));

    return await regenerateFullVaultIndexWithCowork(vaultPath, projects, coworkInfos);
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// Update cowork repo wiki
ipcMain.handle('update-cowork-wiki', async (_event, repoId: string) => {
  try {
    const repos = await loadCoworkRepositories();
    const repo = repos.find(r => r.id === repoId);
    if (!repo) {
      return { success: false, error: 'Repository nicht gefunden' };
    }

    // Check if any wiki option is enabled and vault path is set
    const projectEnabled = repo.wikiProjectEnabled ?? repo.wikiEnabled ?? false;
    const vaultIndexEnabled = repo.wikiVaultIndexEnabled ?? false;

    if (!repo.wikiVaultPath) {
      return { success: false, error: 'Kein Vault-Pfad konfiguriert' };
    }

    if (!projectEnabled && !vaultIndexEnabled) {
      return { success: false, error: 'Weder Projekt-Wiki noch Vault-Index aktiviert' };
    }

    const vaultPath = repo.wikiVaultPath;
    const messages: string[] = [];

    // Get CLAUDE.md content if exists
    let claudeMdContent: string | undefined;
    try {
      claudeMdContent = await fs.promises.readFile(path.join(repo.localPath, 'CLAUDE.md'), 'utf-8');
    } catch {}

    const coworkInfo = {
      name: repo.name,
      path: repo.localPath,
      githubUrl: repo.githubUrl,
      remote: repo.remote,
      branch: repo.branch,
      lastSync: repo.lastSync,
      claudeMdContent
    };

    // Update project wiki if enabled
    if (projectEnabled) {
      const result = await updateCoworkVaultWiki(coworkInfo, vaultPath);
      if (result.success) {
        messages.push('Projekt-Wiki');
      } else {
        return { success: false, error: `Projekt-Wiki Fehler: ${result.error}` };
      }
    }

    // Update vault index entry if enabled (only this project's entry)
    if (vaultIndexEnabled) {
      const result = await updateCoworkVaultIndexEntry(coworkInfo, vaultPath);
      if (result.success) {
        messages.push('Vault-Index');
      } else {
        return { success: false, error: `Vault-Index Fehler: ${result.error}` };
      }
    }

    return {
      success: true,
      message: `Aktualisiert: ${messages.join(', ')}`,
      path: `${vaultPath}/Wiki/Projekte/`
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// Wiki update helper function (called on PTY exit and CLAUDE.md save)
async function triggerWikiUpdate(projectPath: string, projectId: string): Promise<void> {
  try {
    const settingsPath = path.join(CLAUDE_DIR, 'projects', projectId, 'wiki-settings.json');
    let settings: WikiSettings;
    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      return; // Wiki not enabled for this project
    }

    if (!settings.enabled) return;

    const projectName = path.basename(projectPath);
    let gitBranch: string | undefined;
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
    } catch {}

    let claudeMdContent: string | undefined;
    try {
      claudeMdContent = await fs.promises.readFile(path.join(projectPath, 'CLAUDE.md'), 'utf-8');
    } catch {}

    let projectType: 'tools' | 'projekt' = 'projekt';
    try {
      const config = await loadProjectConfig();
      const proj = config.projects?.find((p: { path: string }) => p.path === projectPath);
      if (proj?.type) projectType = proj.type;
    } catch {}

    const changes = settings.fileTrackingEnabled ? getGitChanges(projectPath, settings.lastUpdated) : undefined;

    const result = await updateProjectWiki(
      { name: projectName, path: projectPath, type: projectType, gitBranch, claudeMdContent },
      settings,
      changes
    );

    if (result.success) {
      settings.lastUpdated = new Date().toISOString();
      await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      console.log(`Wiki updated for ${projectName}`);

      // Also update the vault index if enabled and vault path is set
      if (settings.vaultPath && settings.autoUpdateVaultIndex !== false) {
        try {
          const config = await loadProjectConfig();
          const allProjects = [];

          for (const proj of config.projects) {
            const pPath = proj.path;
            const pName = proj.name || path.basename(pPath);
            const pType = proj.type || 'projekt';

            let pGitBranch: string | undefined;
            let pGitDirty = false;

            try {
              pGitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: pPath,
                encoding: 'utf-8'
              }).trim();

              const statusOutput = execSync('git status --porcelain', {
                cwd: pPath,
                encoding: 'utf-8'
              });
              pGitDirty = statusOutput.trim().length > 0;
            } catch {
              // Not a git repo
            }

            allProjects.push({
              name: pName,
              path: pPath,
              type: pType as 'tools' | 'projekt',
              gitBranch: pGitBranch,
              gitDirty: pGitDirty
            });
          }

          // Also load cowork repos for the vault index - filter to this vault only
          // Check if wikiVaultPath starts with vaultPath (project wiki can be in subfolder)
          const coworkRepos = await loadCoworkRepositories();
          const coworkInfos = coworkRepos
            .filter(r => r.wikiEnabled && r.wikiVaultPath && settings.vaultPath && r.wikiVaultPath.startsWith(settings.vaultPath))
            .map(r => ({
              name: r.name,
              path: r.localPath,
              githubUrl: r.githubUrl,
              remote: r.remote,
              branch: r.branch,
              lastSync: r.lastSync
            }));

          await regenerateFullVaultIndexWithCowork(settings.vaultPath, allProjects, coworkInfos);
          console.log(`Vault index updated for ${settings.vaultPath}`);
        } catch (indexErr) {
          console.error('Vault index update failed:', indexErr);
        }
      }
    }
  } catch (err) {
    console.error('triggerWikiUpdate error:', err);
  }
}

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
      projectPath: cwd,
      projectId: cwd.replace(/\//g, '-'),
      buffer: '',
      lastNotification: 0,
      isWaiting: false,
      runsClaude: true,
    });
  }

  ptyProcess.onData((data) => {
    // Buffer output and flush after 8ms to reduce IPC congestion during streaming
    // Notification pattern check runs on the batched data (not every raw chunk)
    // to avoid hundreds of regex ops/sec blocking the event loop during Claude streaming
    const existing = ptyDataBuffers.get(tabId);
    ptyDataBuffers.set(tabId, existing ? existing + data : data);
    if (!ptyDataTimers.has(tabId)) {
      ptyDataTimers.set(tabId, setTimeout(() => {
        ptyDataTimers.delete(tabId);
        const batch = ptyDataBuffers.get(tabId);
        if (batch) {
          ptyDataBuffers.delete(tabId);
          checkForNotificationPatterns(tabId, batch);
          mainWindow?.webContents.send('pty-data', tabId, batch);
        }
      }, 8));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Flush any buffered data before sending exit signal
    const exitTimer = ptyDataTimers.get(tabId);
    if (exitTimer !== undefined) {
      clearTimeout(exitTimer);
      ptyDataTimers.delete(tabId);
    }
    const remaining = ptyDataBuffers.get(tabId);
    if (remaining) {
      ptyDataBuffers.delete(tabId);
      checkForNotificationPatterns(tabId, remaining);
      mainWindow?.webContents.send('pty-data', tabId, remaining);
    }
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);

    // Trigger wiki update on Claude session exit
    const notificationState = tabNotificationStates.get(tabId);
    if (notificationState?.runsClaude) {
      triggerWikiUpdate(notificationState.projectPath, notificationState.projectId).catch(err => {
        console.error('Wiki update failed:', err);
      });
    }

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
  wikiEnabled?: boolean;           // Legacy - kept for backwards compatibility
  wikiVaultPath?: string;
  wikiProjectEnabled?: boolean;    // Update individual project wiki page
  wikiVaultIndexEnabled?: boolean; // Update vault index with this project's entry
}

interface CoworkConfig {
  repositories: CoworkRepository[];
}

async function loadCoworkConfig(): Promise<CoworkConfig> {
  try {
    const content = await fs.promises.readFile(COWORK_CONFIG_PATH, 'utf-8');
    const config: CoworkConfig = JSON.parse(content);

    // Autofix: Normalize GitHub URLs (remove trailing slashes)
    let needsSave = false;
    for (const repo of config.repositories) {
      const normalized = normalizeGitHubUrl(repo.githubUrl);
      if (normalized !== repo.githubUrl) {
        console.log(`[Autofix] Corrected URL: ${repo.githubUrl} -> ${normalized}`);
        repo.githubUrl = normalized;
        needsSave = true;
      }
    }

    // Save corrected config if any URLs were fixed
    if (needsSave) {
      await fs.promises.writeFile(COWORK_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('[Autofix] Saved corrected cowork config');
    }

    return config;
  } catch {
    return { repositories: [] };
  }
}

async function saveCoworkConfig(config: CoworkConfig): Promise<void> {
  await fs.promises.writeFile(COWORK_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function loadCoworkRepositories(): Promise<CoworkRepository[]> {
  const config = await loadCoworkConfig();
  return config.repositories || [];
}

// Cowork IPC handlers
ipcMain.handle('get-cowork-repositories', async () => {
  const config = await loadCoworkConfig();
  const repos = [];

  for (const repo of config.repositories) {
    // Check if path exists AND is a valid git repo
    let pathExists = true;
    let isValidGitRepo = true;
    try {
      await fs.promises.access(repo.localPath);
    } catch {
      pathExists = false;
    }

    if (pathExists) {
      try {
        await fs.promises.access(path.join(repo.localPath, '.git'));
      } catch {
        isValidGitRepo = false;
      }
    } else {
      isValidGitRepo = false;
    }

    let hasCLAUDEmd = false;
    if (pathExists && isValidGitRepo) {
      try {
        await fs.promises.access(path.join(repo.localPath, 'CLAUDE.md'));
        hasCLAUDEmd = true;
      } catch {
        // No CLAUDE.md
      }
    }

    repos.push({
      ...repo,
      hasCLAUDEmd,
      exists: pathExists && isValidGitRepo,
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
    // No CLAUDE.md - create with projekt template
    try {
      const template = getDefaultTemplate('projekt');
      await fs.promises.writeFile(path.join(repo.localPath, 'CLAUDE.md'), template, 'utf-8');
      hasCLAUDEmd = true;
    } catch (err) {
      console.error('Failed to create CLAUDE.md for cowork repo:', err);
    }
  }

  const newRepo: CoworkRepository = {
    id: repo.localPath.replace(/\//g, '-'),
    name: repo.name,
    localPath: repo.localPath,
    githubUrl: normalizeGitHubUrl(repo.githubUrl),
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

ipcMain.handle('update-cowork-path', async (_event, repoId: string, newPath: string) => {
  // Verify new path exists
  try {
    const stat = await fs.promises.stat(newPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Pfad ist kein Ordner' };
    }
  } catch {
    return { success: false, error: 'Pfad existiert nicht' };
  }

  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  if (repo) {
    repo.localPath = newPath;
    await saveCoworkConfig(config);
    await addLogEntry('activity', `Cowork-Pfad aktualisiert: ${repo.name}`, repo.name);
    return { success: true };
  }
  return { success: false, error: 'Repository nicht gefunden' };
});

// Cowork Wiki Settings
ipcMain.handle('get-cowork-wiki-settings', async (_event, repoId: string) => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  if (!repo) {
    return { enabled: false, vaultPath: null };
  }

  // Auto-detect vault path if not set
  const detectedVault = detectVaultPath(repo.localPath);

  return {
    enabled: repo.wikiEnabled || false,
    vaultPath: repo.wikiVaultPath || detectedVault || null
  };
});

ipcMain.handle('save-cowork-wiki-settings', async (_event, repoId: string, settings: {
  wikiVaultPath: string | null;
  wikiProjectEnabled: boolean;
  wikiVaultIndexEnabled: boolean;
}) => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find((r) => r.id === repoId);
  if (!repo) {
    return { success: false, error: 'Repository nicht gefunden' };
  }

  // Update settings
  repo.wikiVaultPath = settings.wikiVaultPath || undefined;
  repo.wikiProjectEnabled = settings.wikiProjectEnabled;
  repo.wikiVaultIndexEnabled = settings.wikiVaultIndexEnabled;
  // Keep legacy wikiEnabled for backwards compatibility
  repo.wikiEnabled = settings.wikiProjectEnabled || settings.wikiVaultIndexEnabled;

  await saveCoworkConfig(config);

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

    // Trigger wiki update on git commit
    const projectId = localPath.replace(/\//g, '-');
    triggerWikiUpdate(localPath, projectId).catch(err => {
      console.error('Wiki update failed on commit:', err);
    });
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

// Normalize GitHub URL (remove trailing slashes)
function normalizeGitHubUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// Extract repo name from GitHub URL
function extractRepoName(githubUrl: string): string {
  const normalized = normalizeGitHubUrl(githubUrl);
  const match = normalized.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : 'repo';
}

// Validate cowork repository before adding
ipcMain.handle('validate-cowork-repository', async (_event, githubUrl: string, localPath?: string, _remote?: string, _branch?: string) => {
  // Normalize URL (remove trailing slashes)
  const normalizedUrl = normalizeGitHubUrl(githubUrl);
  const repoName = extractRepoName(normalizedUrl);
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
        // Folder exists but is not a git repo - clone to default path instead
        result.localPath = defaultLocalPath;
        result.valid = true;
        result.needsClone = true;
        result.error = `Ordner "${localPath}" ist kein Git-Repository. Wird nach "${defaultLocalPath}" geklont.`;
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
      // Path doesn't exist - clone to this path
      result.valid = true;
      result.needsClone = true;
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

// Track repos where we hold an active lock → auto-release on app quit
const activeLocks = new Map<string, { remote: string; branch: string }>();

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

    activeLocks.set(repoPath, { remote, branch });
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

    // Git add, commit
    execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync(`git commit -m "🔓 Unlock: ${getUsername()}@${getMachineName()} finished working"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Pull --rebase first so push doesn't fail if branch diverged since lock was created
    try {
      execSync(`git pull --rebase --autostash ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    } catch { /* ignore – push may still succeed */ }
    execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    activeLocks.delete(repoPath);
    await addLogEntry('activity', `Cowork Lock freigegeben: ${path.basename(repoPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('force-release-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);

  try {
    // Fetch + hard reset to remote state – avoids any rebase/merge conflicts
    execSync(`git fetch ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    execSync(`git reset --hard FETCH_HEAD`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    // Check if lock file exists on remote after reset
    try {
      await fs.promises.access(lockPath);
    } catch {
      return { success: true }; // Already unlocked on remote
    }

    // Remove lock file
    await fs.promises.unlink(lockPath);

    // Git add, commit, push (guaranteed to succeed – we're exactly 1 commit ahead of remote)
    execSync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync(`git commit -m "🔓 Force Unlock: ${getUsername()}@${getMachineName()} (override)"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    execSync(`git push ${remote} ${branch}`, { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });

    activeLocks.delete(repoPath);
    await addLogEntry('activity', `Cowork Lock force-released: ${path.basename(repoPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('clone-cowork-repository', async (_event, githubUrl: string, targetPath: string) => {
  try {
    // Normalize URL (remove trailing slashes)
    const normalizedUrl = normalizeGitHubUrl(githubUrl);

    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    await fs.promises.mkdir(parentDir, { recursive: true });

    // Clone the repository
    execSync(`git clone "${normalizedUrl}" "${targetPath}"`, {
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

  // If a path is specified, try it first (with ~ expansion and cross-user normalization)
  if (specifiedPath) {
    let normalizedPath = specifiedPath;

    // Replace ~ with actual home dir
    normalizedPath = normalizedPath.replace(/^~/, homeDir);

    // Convert other user's home paths to current user's home
    // e.g., /Users/denizschlosser/.ssh/key -> /Users/timon/.ssh/key
    const otherUserPattern = /^\/Users\/[^/]+\/\.ssh\//;
    if (otherUserPattern.test(normalizedPath)) {
      const keyName = normalizedPath.replace(otherUserPattern, '');
      normalizedPath = path.join(homeDir, '.ssh', keyName);
      console.log(`[SSH] Normalized path from other user: ${specifiedPath} -> ${normalizedPath}`);
    }

    pathsToTry.push(normalizedPath);
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
    const healthResult = execSync(`curl -s -k --max-time 10 "${urls.production}${urls.health}" 2>/dev/null || echo '{}'`, {
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
    const healthUrl = `${config.urls.production}${config.urls.health}`;
    console.log(`Health check URL: ${healthUrl}`);

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        // Use -k for self-signed certs, -w to get HTTP status code
        const httpCode = execSync(`curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 "${healthUrl}" 2>/dev/null || echo "000"`, {
          encoding: 'utf-8',
        }).trim();

        console.log(`Health check attempt ${i + 1}/30: HTTP ${httpCode}`);

        // Accept 2xx status codes as healthy
        if (httpCode.startsWith('2')) {
          healthOk = true;
          break;
        }
      } catch (err) {
        console.log(`Health check attempt ${i + 1}/30: Error - ${(err as Error).message}`);
        // Continue waiting
      }
    }

    if (!healthOk) {
      updateStep('health', 'error', `Health Check Timeout (${healthUrl})`);
      return { success: false, duration: Date.now() - startTime, steps, error: `Health Check fehlgeschlagen nach 60 Sekunden: ${healthUrl}` };
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
      downloadUrl = updateInfo.zipUrl;
      fileName = `Claude-MC-${updateInfo.version}-arm64-mac.zip`;
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
        // 1. Extract ZIP to temp directory
        const extractDir = path.join(tempDir, `claude-mc-update-${Date.now()}`);
        console.log('[Update] Extracting ZIP to:', extractDir);
        await addLogEntry('activity', '[Update] Entpacke ZIP...');
        fs.mkdirSync(extractDir, { recursive: true });
        // Use ditto instead of unzip - preserves symlinks required by Electron Frameworks
        execSync(`ditto -xk "${filePath}" "${extractDir}"`, { encoding: 'utf-8' });

        // 2. Find the .app in the extracted content
        const appFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.app'));
        if (appFiles.length === 0) {
          throw new Error('No .app found in ZIP');
        }
        const appName = appFiles[0];
        const sourceApp = path.join(extractDir, appName);
        const targetApp = `/Applications/${appName}`;

        console.log('[Update] Source:', sourceApp);
        console.log('[Update] Target:', targetApp);
        await addLogEntry('activity', `[Update] Kopiere ${appName} nach /Applications...`);

        // 3. Remove old app and copy new one using ditto (preserves macOS symlinks)
        execSync(`rm -rf "${targetApp}"`, { encoding: 'utf-8' });
        execSync(`ditto "${sourceApp}" "${targetApp}"`, { encoding: 'utf-8' });

        // Remove quarantine attribute to prevent Gatekeeper blocking
        try {
          execSync(`xattr -rd com.apple.quarantine "${targetApp}"`, { encoding: 'utf-8' });
          console.log('[Update] Quarantine attribute removed');
        } catch {
          console.log('[Update] No quarantine attribute to remove');
        }

        console.log('[Update] App copied successfully');
        await addLogEntry('activity', '[Update] App kopiert!');

        // 4. Cleanup ZIP and extracted directory
        // Use shell rm -rf instead of fs.rmSync to avoid ASAR virtualization issues
        try {
          execSync(`rm -rf "${filePath}" "${extractDir}"`);
        } catch { /* ignore cleanup errors, installation already succeeded */ }
        await addLogEntry('activity', '[Update] Temporäre Dateien bereinigt');

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
        // Claude is ready when it shows the "? for shortcuts" message or the > prompt
        if (data.includes('for shortcuts') || data.includes('How can I help') || data.includes('╭─')) {
          extSession.claudeStarted = true;
          session.responseBuffer = ''; // Clear any startup noise
          // Don't send the startup message itself
          return;
        }
        // Don't process data until Claude is ready
        return;
      }

      // Skip if this looks like startup noise that slipped through
      const stripData = stripAnsi(data);
      if (stripData.includes('MCP server') ||
          stripData.includes('Auto-update') ||
          stripData.includes('for shortcuts') ||
          stripData.includes('@anthropic-ai')) {
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

  // Filter out terminal noise and Claude startup messages
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
    /^\?\s*for shortcuts/i,               // Claude startup hint
    /MCP server failed/i,                 // MCP error messages
    /Auto-updating/i,                     // Auto-update message
    /Auto-update failed/i,                // Auto-update error
    /claude doctor/i,                     // Claude doctor suggestion
    /npm i -g/i,                          // npm install suggestion
    /@anthropic-ai\/claude-code/,         // Package name
    /^×/,                                 // Error symbol lines
    /^\s*\?\s*$/,                          // Just ? character
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

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('get-orchestrator-key', async () => {
  // CLI mode – kein API Key nötig
  return 'cli';
});

ipcMain.handle('save-orchestrator-key', async () => {
  return { success: true };
});

ipcMain.handle('get-project-contexts', async (_event, projectPaths: string[]) => {
  const contexts: Record<string, string> = {};
  for (const projectPath of projectPaths) {
    try {
      const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        contexts[projectPath] = fs.readFileSync(claudeMdPath, 'utf-8');
      } else {
        contexts[projectPath] = '(Keine CLAUDE.md vorhanden)';
      }
    } catch {
      contexts[projectPath] = '(Fehler beim Lesen)';
    }
  }
  return contexts;
});

ipcMain.handle('orchestrator-chat', async (event, messages: OrchestratorMessage[], projectPaths: string[]) => {
  const claudeStatus = checkClaudeCode();
  if (!claudeStatus.installed || !claudeStatus.path) {
    return { success: false, error: 'Claude CLI nicht installiert oder nicht im PATH.' };
  }

  // Build full prompt: context + conversation history + current message
  let prompt = '# ORCHESTRATOR KONTEXT\n\n';
  prompt += 'Du bist der Claude MC Orchestrator. Beantworte die Anfrage basierend auf dem Kontext der folgenden Projekte.\n';
  prompt += 'Hilf bei projektübergreifenden Fragen, koordiniere Tasks und gib konkrete Antworten.\n\n';

  // Include persistent memory
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const memory = fs.readFileSync(MEMORY_FILE, 'utf-8').trim();
      if (memory) {
        prompt += `# PERSISTENTES GEDÄCHTNIS\n\n${memory}\n\n---\n\n`;
      }
    }
  } catch { /* ignore */ }

  if (projectPaths.length > 0) {
    for (const projectPath of projectPaths) {
      try {
        const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
        const projectName = path.basename(projectPath);
        const content = fs.existsSync(claudeMdPath)
          ? fs.readFileSync(claudeMdPath, 'utf-8')
          : '(Keine CLAUDE.md vorhanden)';
        prompt += `## [${projectName}] (${projectPath})\n\n${content}\n\n---\n\n`;
      } catch { /* ignore */ }
    }
  }

  // Conversation history (all but last message)
  if (messages.length > 1) {
    prompt += '# BISHERIGER VERLAUF\n\n';
    for (const m of messages.slice(0, -1)) {
      prompt += `**${m.role === 'user' ? 'Nutzer' : 'Assistent'}:**\n${m.content}\n\n`;
    }
  }

  // Current message
  const lastMsg = messages[messages.length - 1];
  prompt += `# AKTUELLE ANFRAGE\n\n${lastMsg.content}`;

  return new Promise((resolve) => {
    const child = spawn(claudeStatus.path!, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--verbose',
      '--model', 'opus',
    ], {
      env: {
        ...process.env,
        PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();

    let buffer = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          // Extract text from stream_event content_block_delta
          if (
            json.type === 'stream_event' &&
            json.event?.type === 'content_block_delta' &&
            json.event?.delta?.type === 'text_delta' &&
            json.event?.delta?.text
          ) {
            try { event.sender.send('orchestrator-chunk', json.event.delta.text); } catch { /* renderer gone */ }
          }
        } catch { /* ignore non-JSON lines */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      console.log('[Orchestrator stderr]', data.toString().trim());
    });

    child.on('close', (code) => {
      try { event.sender.send('orchestrator-chunk', null); } catch { /* renderer gone */ }
      resolve({ success: code === 0, error: code !== 0 ? `Claude CLI exit code ${code}` : undefined });
    });

    child.on('error', (err) => {
      try { event.sender.send('orchestrator-chunk', null); } catch { /* renderer gone */ }
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('save-orchestrator-log', async (_event, title: string, content: string) => {
  try {
    const logsDir = path.join(MC_WIKI_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = title.replace(/[^a-zA-Z0-9-_äöüÄÖÜ ]/g, '').replace(/\s+/g, '-').slice(0, 50);
    const filename = `${timestamp}-${safeTitle}.md`;
    const filePath = path.join(logsDir, filename);
    const fullContent = `# ${title}\n\n*Gespeichert: ${new Date().toLocaleString('de-DE')}*\n\n---\n\n${content}`;
    fs.writeFileSync(filePath, fullContent, 'utf-8');
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENT MEMORY IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('memory-get', async () => {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return { success: true, content: fs.readFileSync(MEMORY_FILE, 'utf-8') };
    }
    return { success: true, content: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('memory-save', async (_event, content: string) => {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('memory-update', async (event, messages: OrchestratorMessage[]) => {
  const claudeStatus = checkClaudeCode();
  if (!claudeStatus.installed || !claudeStatus.path) {
    return { success: false, error: 'Claude CLI nicht gefunden.' };
  }

  let currentMemory = '(Noch kein Gedächtnis vorhanden)';
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      currentMemory = fs.readFileSync(MEMORY_FILE, 'utf-8').trim() || currentMemory;
    }
  } catch { /* ignore */ }

  const recentMessages = messages.slice(-10).map(m =>
    `**${m.role === 'user' ? 'Nutzer' : 'Assistent'}:** ${m.content}`
  ).join('\n\n');

  const prompt = `Du bist ein Memory-Manager für den ClaudeMC Assistenten.

Aktualisiere das folgende strukturierte Gedächtnis basierend auf dem neuen Gespräch.

REGELN:
- Behalte exakt diese Markdown-Struktur mit Inhaltsverzeichnis
- Füge NUR neue, relevante Informationen hinzu
- Fasse ähnliche Punkte zusammen, entferne veraltete Informationen
- Maximal 3000 Zeichen insgesamt
- Antworte NUR mit dem aktualisierten Gedächtnis-Dokument, kein anderer Text
- Timestamp aktualisieren

STRUKTUR (falls noch kein Gedächtnis):
# ClaudeMC Gedächtnis
*Aktualisiert: [DATUM]*

## Inhaltsverzeichnis
1. [Laufende Projekte & Status](#laufende-projekte--status)
2. [Wichtige Entscheidungen](#wichtige-entscheidungen)
3. [Offene Tasks](#offene-tasks)
4. [Präferenzen & Arbeitsweise](#präferenzen--arbeitsweise)
5. [Technische Erkenntnisse](#technische-erkenntnisse)

## Laufende Projekte & Status
(leer)

## Wichtige Entscheidungen
(leer)

## Offene Tasks
(leer)

## Präferenzen & Arbeitsweise
(leer)

## Technische Erkenntnisse
(leer)

---

AKTUELLES GEDÄCHTNIS:
${currentMemory}

NEUES GESPRÄCH (letzte Nachrichten):
${recentMessages}`;

  return new Promise((resolve) => {
    const child = spawn(claudeStatus.path!, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--verbose',
      '--model', 'opus',
    ], {
      env: {
        ...process.env,
        PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();

    let buffer = '';
    let fullText = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (
            json.type === 'stream_event' &&
            json.event?.type === 'content_block_delta' &&
            json.event?.delta?.type === 'text_delta' &&
            json.event?.delta?.text
          ) {
            fullText += json.event.delta.text;
          }
        } catch { /* skip */ }
      }
    });

    child.on('close', (code) => {
      if (code === 0 && fullText.trim()) {
        try {
          fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
          fs.writeFileSync(MEMORY_FILE, fullText.trim(), 'utf-8');
          event.sender.send('memory-updated', fullText.trim());
          resolve({ success: true });
        } catch (err) {
          resolve({ success: false, error: (err as Error).message });
        }
      } else {
        resolve({ success: false, error: `Exit code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL WIKI IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function ensureWikiDirs() {
  fs.mkdirSync(path.join(MC_WIKI_DIR, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(MC_WIKI_DIR, 'logs'), { recursive: true });
}

ipcMain.handle('wiki-get-page', async (_event, pagePath: string) => {
  try {
    ensureWikiDirs();
    const fullPath = path.join(MC_WIKI_DIR, pagePath);
    if (fs.existsSync(fullPath)) {
      return { success: true, content: fs.readFileSync(fullPath, 'utf-8') };
    }
    return { success: true, content: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('wiki-save-page', async (_event, pagePath: string, content: string) => {
  try {
    ensureWikiDirs();
    const fullPath = path.join(MC_WIKI_DIR, pagePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('wiki-list-pages', async () => {
  try {
    ensureWikiDirs();
    const projectsDir = path.join(MC_WIKI_DIR, 'projects');
    const logsDir = path.join(MC_WIKI_DIR, 'logs');

    const projects = fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir).filter(f => f.endsWith('.md')).map(f => ({
          name: f.replace('.md', ''),
          path: `projects/${f}`,
          mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs,
        }))
      : [];

    const logs = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir).filter(f => f.endsWith('.md')).sort().reverse().map(f => ({
          name: f.replace('.md', ''),
          path: `logs/${f}`,
          mtime: fs.statSync(path.join(logsDir, f)).mtimeMs,
        }))
      : [];

    return { success: true, projects, logs };
  } catch (err) {
    return { success: false, error: (err as Error).message, projects: [], logs: [] };
  }
});

ipcMain.handle('wiki-sync-project', async (_event, projectPath: string, projectId: string) => {
  try {
    ensureWikiDirs();
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    const projectName = path.basename(projectPath);
    let claudeMdContent = '(Keine CLAUDE.md vorhanden)';

    if (fs.existsSync(claudeMdPath)) {
      claudeMdContent = fs.readFileSync(claudeMdPath, 'utf-8');
    }

    // Get git branch
    let gitBranch = 'unbekannt';
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* ignore */ }

    const content = `# ${projectName}\n\n*Synchronisiert: ${new Date().toLocaleString('de-DE')} | Branch: ${gitBranch}*\n\n---\n\n${claudeMdContent}`;
    const wikiPath = path.join(MC_WIKI_DIR, 'projects', `${projectId}.md`);
    fs.writeFileSync(wikiPath, content, 'utf-8');

    return { success: true, path: wikiPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUB-AGENTS IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('create-agent', async (_event, agentId: string, projectPath: string, task: string) => {
  try {
    const claudeStatus = checkClaudeCode();
    if (!claudeStatus.installed || !claudeStatus.path) {
      return { success: false, error: 'Claude CLI nicht installiert oder nicht im PATH.' };
    }

    const projectName = path.basename(projectPath);
    const entry: AgentEntry = {
      id: agentId,
      projectPath,
      projectName,
      task,
      state: 'running',
      output: '',
      createdAt: new Date().toISOString(),
    };
    agentMap.set(agentId, entry);
    mainWindow?.webContents.send('agent-list-updated');

    const child = spawn(claudeStatus.path, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--verbose',
      '--model', 'opus',
    ], {
      cwd: projectPath,
      env: {
        ...process.env,
        PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    entry.process = child;
    child.stdin.write(task, 'utf-8');
    child.stdin.end();

    let buffer = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (
            json.type === 'stream_event' &&
            json.event?.type === 'content_block_delta' &&
            json.event?.delta?.type === 'text_delta' &&
            json.event?.delta?.text
          ) {
            const text = json.event.delta.text;
            // Cap output at 100k chars to avoid unbounded memory growth
            if (entry.output.length < 100_000) {
              entry.output += text;
            }
            mainWindow?.webContents.send('agent-chunk', { agentId, text });
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      console.log(`[Agent ${agentId} stderr]`, data.toString().trim());
    });

    child.on('close', (code) => {
      const current = agentMap.get(agentId);
      if (current) {
        current.state = code === 0 ? 'done' : 'error';
        current.exitCode = code ?? undefined;
        current.finishedAt = new Date().toISOString();
        if (code !== 0 && !current.output) {
          current.error = `Claude CLI exited with code ${code}`;
        }
        delete current.process;
      }
      mainWindow?.webContents.send('agent-chunk', { agentId, done: true });
      mainWindow?.webContents.send('agent-list-updated');
    });

    child.on('error', (err) => {
      const current = agentMap.get(agentId);
      if (current) {
        current.state = 'error';
        current.error = err.message;
        current.finishedAt = new Date().toISOString();
        delete current.process;
      }
      mainWindow?.webContents.send('agent-chunk', { agentId, done: true, error: err.message });
      mainWindow?.webContents.send('agent-list-updated');
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('stop-agent', async (_event, agentId: string) => {
  try {
    const entry = agentMap.get(agentId);
    if (entry?.process) {
      entry.process.kill('SIGTERM');
      entry.state = 'error';
      entry.error = 'Gestoppt';
      entry.finishedAt = new Date().toISOString();
      delete entry.process;
      mainWindow?.webContents.send('agent-list-updated');
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('list-agents', async () => {
  const agents = Array.from(agentMap.values()).map(({ process: _p, ...rest }) => rest);
  return agents;
});

ipcMain.handle('clear-agent', async (_event, agentId: string) => {
  agentMap.delete(agentId);
  mainWindow?.webContents.send('agent-list-updated');
  return { success: true };
});

ipcMain.handle('clear-all-agents', async () => {
  for (const [id, entry] of agentMap.entries()) {
    if (entry.state === 'done' || entry.state === 'error') {
      agentMap.delete(id);
    }
  }
  mainWindow?.webContents.send('agent-list-updated');
  return { success: true };
});

// AUTO-MAIL IPC HANDLERS
const MAIL_ACCOUNTS_PATH = path.join(os.homedir(), '.claude', 'mail-accounts.json');

function loadMailAccounts(): import('../shared/types').MailAccount[] {
  try {
    if (fs.existsSync(MAIL_ACCOUNTS_PATH)) {
      return JSON.parse(fs.readFileSync(MAIL_ACCOUNTS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveMailAccounts(accounts: import('../shared/types').MailAccount[]): void {
  fs.mkdirSync(path.dirname(MAIL_ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(MAIL_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

ipcMain.handle('get-mail-accounts', async (): Promise<import('../shared/types').MailAccount[]> => {
  return loadMailAccounts();
});

ipcMain.handle('save-mail-account', async (_event, account: import('../shared/types').MailAccount): Promise<{ success: boolean; error?: string }> => {
  try {
    const accounts = loadMailAccounts();
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx >= 0) {
      accounts[idx] = account;
    } else {
      accounts.push(account);
    }
    saveMailAccounts(accounts);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('remove-mail-account', async (_event, accountId: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const accounts = loadMailAccounts().filter(a => a.id !== accountId);
    saveMailAccounts(accounts);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Helpers: IMAP encoded-word decoder ─────────────────────────────────────
function decodeImapEncodedWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_full, _charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(encoded, 'base64').toString('utf8');
      } else {
        return encoded.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
          (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
    } catch { return encoded; }
  });
}

function parseImapFetchResponse(raw: string, firstSeq: number): import('../shared/types').MailMessage[] {
  const messages: import('../shared/types').MailMessage[] = [];
  const blockRe = /\* (\d+) FETCH /g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(raw)) !== null) positions.push(m.index);
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : raw.length;
    const block = raw.slice(start, end);
    const flagsMatch = block.match(/FLAGS \(([^)]*)\)/);
    const seen = flagsMatch ? flagsMatch[1].includes('\\Seen') : false;
    const fromMatch = block.match(/^From:\s*(.+)$/im);
    const subjectMatch = block.match(/^Subject:\s*(.+)$/im);
    const dateMatch = block.match(/^Date:\s*(.+)$/im);
    const seqMatch = block.match(/^\* (\d+) FETCH/);
    const uid = seqMatch ? parseInt(seqMatch[1]) : (firstSeq + i);
    messages.push({
      uid,
      subject: subjectMatch ? decodeImapEncodedWords(subjectMatch[1].trim()) : '(kein Betreff)',
      from: fromMatch ? decodeImapEncodedWords(fromMatch[1].trim()) : '(unbekannt)',
      date: dateMatch ? dateMatch[1].trim() : '',
      seen,
      preview: '',
    });
  }
  return messages.reverse();
}

// ─── OAuth2 helpers ───────────────────────────────────────────────────────────
function getOAuth2TokenPath(accountId: string): string {
  const dir = path.join(os.homedir(), '.claude', 'mail-tokens');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function loadOAuth2Tokens(accountId: string): import('../shared/types').OAuth2Tokens | null {
  try {
    const p = getOAuth2TokenPath(accountId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function saveOAuth2Tokens(accountId: string, tokens: import('../shared/types').OAuth2Tokens): void {
  fs.writeFileSync(getOAuth2TokenPath(accountId), JSON.stringify(tokens, null, 2));
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function msTokenRequest(tenantId: string, body: URLSearchParams): Promise<import('../shared/types').OAuth2Tokens> {
  return new Promise((resolve, reject) => {
    const bodyStr = body.toString();
    const req = https.request({
      hostname: 'login.microsoftonline.com',
      path: `/${tenantId}/oauth2/v2.0/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => data += c.toString());
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error_description || json.error)); return; }
          resolve({
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + (parseInt(json.expires_in) * 1000),
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getValidAccessToken(account: import('../shared/types').MailAccount): Promise<string> {
  const tokens = loadOAuth2Tokens(account.id);
  if (!tokens) throw new Error('Kein OAuth2-Token. Bitte zuerst mit Microsoft anmelden.');
  if (Date.now() < tokens.expiresAt - 60000) return tokens.accessToken;
  // Refresh
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: account.oauth2ClientId!,
    refresh_token: tokens.refreshToken,
    scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
  });
  const refreshed = await msTokenRequest(account.oauth2TenantId || 'common', body);
  if (!refreshed.refreshToken) refreshed.refreshToken = tokens.refreshToken;
  saveOAuth2Tokens(account.id, refreshed);
  return refreshed.accessToken;
}

// ─── OAuth2: Authorize (PKCE + local HTTP server) ─────────────────────────────
ipcMain.handle('oauth2-authorize', async (event, account: import('../shared/types').MailAccount): Promise<{ success: boolean; error?: string }> => {
  const { verifier, challenge } = generatePKCE();
  const tenantId = account.oauth2TenantId || 'common';
  const clientId = account.oauth2ClientId!;

  return new Promise((resolve) => {
    let redirectUri = '';

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      const code = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a1a;color:#fff"><h2>&#x2705; Anmeldung erfolgreich!</h2><p>Dieses Fenster kann geschlossen werden.</p></body></html>');
        server.close();
        clearTimeout(timeout);
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
        });
        msTokenRequest(tenantId, body).then((tokens) => {
          saveOAuth2Tokens(account.id, tokens);
          event.sender.send('oauth2-complete', { accountId: account.id, success: true });
          resolve({ success: true });
        }).catch((err: Error) => {
          event.sender.send('oauth2-complete', { accountId: account.id, success: false, error: err.message });
          resolve({ success: false, error: err.message });
        });
      } else {
        const errDesc = url.searchParams.get('error_description') || '';
        const errMsg = oauthError || 'Abgebrochen';
        // Extract AADSTS code for better diagnostics
        const aadsts = errDesc.match(/AADSTS\d+/)?.[0] ?? '';
        let hint = '';
        if (aadsts === 'AADSTS50194') hint = '<p style="color:#f59e0b;font-size:13px">&#x2139;&#xFE0F; Trage deine genaue <strong>Tenant-ID</strong> ein (nicht "common"). Azure Portal → Azure Active Directory → Overview → Directory (tenant) ID.</p>';
        else if (aadsts === 'AADSTS700016') hint = '<p style="color:#f59e0b;font-size:13px">&#x2139;&#xFE0F; Client ID nicht gefunden – prüfe die Application (client) ID in Azure Portal.</p>';
        else if (errMsg === 'invalid_request') hint = '<p style="color:#f59e0b;font-size:13px">&#x2139;&#xFE0F; Redirect URI fehlt in Azure Portal: Authentication → Add platform → Mobile/Desktop → <code>http://localhost</code></p>';
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#1a1a1a;color:#fff"><h2>&#x274C; Fehler</h2><p style="color:#ef4444">${errMsg}${aadsts ? ` (${aadsts})` : ''}</p>${hint}<p style="font-size:11px;color:#666;margin-top:20px">${errDesc.slice(0, 200)}</p></body></html>`);
        server.close();
        clearTimeout(timeout);
        const fullError = aadsts ? `${errMsg} (${aadsts})` : errMsg;
        event.sender.send('oauth2-complete', { accountId: account.id, success: false, error: fullError });
        resolve({ success: false, error: fullError });
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'OAuth2 Timeout (5 min)' });
    }, 5 * 60 * 1000);

    server.on('error', (err: Error) => { clearTimeout(timeout); resolve({ success: false, error: err.message }); });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirectUri = `http://localhost:${port}`;
      const authParams = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        response_mode: 'query',
        login_hint: account.user, // force correct account – prevents NoADRecipient mismatch
      });
      shell.openExternal(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${authParams}`);
    });
  });
});

// ─── OAuth2: Status + Revoke ──────────────────────────────────────────────────
ipcMain.handle('oauth2-get-status', async (_event, accountId: string): Promise<{ authorized: boolean; expiresAt?: number }> => {
  const tokens = loadOAuth2Tokens(accountId);
  if (!tokens) return { authorized: false };
  return { authorized: true, expiresAt: tokens.expiresAt };
});

ipcMain.handle('oauth2-revoke', async (_event, accountId: string): Promise<{ success: boolean }> => {
  try {
    const p = getOAuth2TokenPath(accountId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { success: true };
  } catch { return { success: false }; }
});

function imapLoginError(rawLine: string): string {
  if (rawLine.includes('NoADRecipient') || rawLine.includes('AuthResultFromPopImapEnd')) {
    return `Login fehlgeschlagen: IMAP ist für diese Mailbox deaktiviert.\n` +
      `Exchange Admin → Empfänger → Postfächer → [Konto] → E-Mail-Apps → IMAP aktivieren\n` +
      `(oder PowerShell: Set-CasMailbox -Identity "..." -ImapEnabled $true)\n\nDetails: ${rawLine}`;
  }
  if (rawLine.includes('AADSTS')) {
    const code = rawLine.match(/AADSTS\d+/)?.[0] ?? '';
    return `Login fehlgeschlagen (${code}): OAuth2-Konfigurationsfehler. Tenant-ID prüfen.\n\nDetails: ${rawLine}`;
  }
  return `Login fehlgeschlagen: ${rawLine}`;
}

ipcMain.handle('fetch-mail-messages', async (_event, account: import('../shared/types').MailAccount, limit: number = 20): Promise<{ success: boolean; messages?: import('../shared/types').MailMessage[]; total?: number; error?: string }> => {
  // Pre-fetch OAuth2 token if needed (async, before state machine)
  let resolvedToken: string | null = null;
  if (account.authType === 'oauth2') {
    try { resolvedToken = await getValidAccessToken(account); }
    catch (err) { return { success: false, error: (err as Error).message }; }
  }

  return new Promise((resolve) => {
    const TIMEOUT_MS = 20000;
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ success: false, error: 'Timeout (20s)' });
    }, TIMEOUT_MS);

    let buf = '';
    let tagN = 0;
    const tag = (cmd: string) => {
      const t = `MC${++tagN}`;
      socket.write(`${t} ${cmd}\r\n`);
      return t;
    };

    type Phase = 'greeting' | 'login' | 'select' | 'fetch' | 'done';
    let phase: Phase = 'greeting';
    let loginTag = '', selectTag = '', fetchTag = '';
    let msgTotal = 0;
    let fetchBuf = '';

    const finish = (result: { success: boolean; messages?: import('../shared/types').MailMessage[]; total?: number; error?: string }) => {
      clearTimeout(timeout);
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const connectOpts = { host: account.host, port: account.port, rejectUnauthorized: false };
    const socket = account.ssl
      ? tls.connect(connectOpts as tls.ConnectionOptions, () => {})
      : net.createConnection({ host: account.host, port: account.port });

    socket.on('error', (err: Error) => finish({ success: false, error: err.message }));

    socket.on('data', (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop()!;

      for (const line of lines) {
        if (phase === 'greeting') {
          if (line.startsWith('* OK')) {
            phase = 'login';
            if (resolvedToken) {
              const xoauth2 = Buffer.from(`user=${account.user}\x01auth=Bearer ${resolvedToken}\x01\x01`).toString('base64');
              loginTag = tag(`AUTHENTICATE XOAUTH2 ${xoauth2}`);
            } else {
              const u = account.user.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              const p = account.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              loginTag = tag(`LOGIN "${u}" "${p}"`);
            }
          }
        } else if (phase === 'login') {
          if (line.startsWith(loginTag + ' OK')) {
            phase = 'select';
            selectTag = tag(`SELECT "${account.folder}"`);
          } else if (line.startsWith('+ ') && resolvedToken) {
            // XOAUTH2 error challenge – send empty line to get NO response
            socket.write('\r\n');
          } else if (line.startsWith(loginTag + ' ') && !line.startsWith(loginTag + ' OK')) {
            finish({ success: false, error: imapLoginError(line.slice(loginTag.length + 1)) });
            return;
          }
        } else if (phase === 'select') {
          const existsM = line.match(/^\* (\d+) EXISTS/);
          if (existsM) msgTotal = parseInt(existsM[1]);
          if (line.startsWith(selectTag + ' OK')) {
            if (msgTotal === 0) { finish({ success: true, messages: [], total: 0 }); return; }
            const start = Math.max(1, msgTotal - limit + 1);
            phase = 'fetch';
            fetchTag = tag(`FETCH ${start}:${msgTotal} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
          } else if (line.startsWith(selectTag + ' NO') || line.startsWith(selectTag + ' BAD')) {
            finish({ success: false, error: `SELECT fehlgeschlagen: ${line}` });
            return;
          }
        } else if (phase === 'fetch') {
          fetchBuf += line + '\r\n';
          if (line.startsWith(fetchTag + ' OK')) {
            phase = 'done';
            const firstSeq = Math.max(1, msgTotal - limit + 1);
            finish({ success: true, messages: parseImapFetchResponse(fetchBuf, firstSeq), total: msgTotal });
          } else if (line.startsWith(fetchTag + ' NO') || line.startsWith(fetchTag + ' BAD')) {
            finish({ success: false, error: `FETCH fehlgeschlagen: ${line}` });
          }
        }
      }
    });
  });
});

// SSH Docker Status
ipcMain.handle('get-server-docker-status', async (_event, host: string, user: string, sshKeyPath?: string): Promise<{ success: boolean; containers?: { name: string; status: string; ports: string; image: string }[]; error?: string }> => {
  return new Promise((resolve) => {
    const keyArg = sshKeyPath ? `-i "${sshKeyPath.replace('~', os.homedir())}"` : '';
    const sshCmd = `ssh ${keyArg} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes ${user}@${host} 'docker ps --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}"'`;
    exec(sshCmd, { timeout: 15000 }, (err, stdout) => {
      if (err) { resolve({ success: false, error: err.message }); return; }
      const containers = stdout.trim().split('\n')
        .filter(l => l.trim())
        .map(l => {
          const parts = l.split('\t');
          return { name: parts[0] || '', status: parts[1] || '', ports: parts[2] || '', image: parts[3] || '' };
        });
      resolve({ success: true, containers });
    });
  });
});

// ─── HTML-to-text strip ──────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}

// ─── Ollama HTTP helper ───────────────────────────────────────────────────────
function getHttpModule(urlStr: string): typeof http | typeof https {
  return urlStr.startsWith('https') ? https : http;
}

function ollamaGet(urlStr: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const base = new URL(path, urlStr);
    const mod = getHttpModule(urlStr);
    mod.get(base.href, (res) => {
      let data = '';
      res.on('data', c => data += c.toString());
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function ollamaStream(
  urlStr: string, body: object,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void
): void {
  const base = new URL('/api/chat', urlStr);
  const mod = getHttpModule(urlStr);
  const bodyStr = JSON.stringify(body);
  const port = base.port ? parseInt(base.port) : (base.protocol === 'https:' ? 443 : 80);
  const req = (mod as typeof http).request({
    hostname: base.hostname,
    port,
    path: base.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  }, (res) => {
    let buf = '';
    let finished = false;
    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) onChunk(json.message.content);
          if (json.done && !finished) { finished = true; onDone(); }
        } catch {}
      }
    });
    res.on('end', () => { if (!finished) onDone(); });
  });
  req.on('error', onError);
  req.write(bodyStr);
  req.end();
}

// ─── IMAP body fetch ─────────────────────────────────────────────────────────
ipcMain.handle('fetch-mail-body', async (_event, account: import('../shared/types').MailAccount, seqNum: number): Promise<{ success: boolean; text?: string; error?: string }> => {
  let resolvedToken: string | null = null;
  if (account.authType === 'oauth2') {
    try { resolvedToken = await getValidAccessToken(account); }
    catch (err) { return { success: false, error: (err as Error).message }; }
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { socket.destroy(); resolve({ success: false, error: 'Timeout (20s)' }); }, 20000);
    let buf = '';
    let tagN = 0;
    const tag = (cmd: string) => { const t = `MB${++tagN}`; socket.write(`${t} ${cmd}\r\n`); return t; };
    type Phase = 'greeting' | 'login' | 'select' | 'fetch' | 'done';
    let phase: Phase = 'greeting';
    let loginTag = '', selectTag = '', fetchTag = '';
    let fetchBuf = '';
    const finish = (r: { success: boolean; text?: string; error?: string }) => {
      clearTimeout(timeout); try { socket.destroy(); } catch {} resolve(r);
    };
    const socket = account.ssl
      ? tls.connect({ host: account.host, port: account.port, rejectUnauthorized: false } as tls.ConnectionOptions, () => {})
      : net.createConnection({ host: account.host, port: account.port });
    socket.on('error', (err: Error) => finish({ success: false, error: err.message }));
    socket.on('data', (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (phase === 'greeting' && line.startsWith('* OK')) {
          phase = 'login';
          if (resolvedToken) {
            const xoauth2 = Buffer.from(`user=${account.user}\x01auth=Bearer ${resolvedToken}\x01\x01`).toString('base64');
            loginTag = tag(`AUTHENTICATE XOAUTH2 ${xoauth2}`);
          } else {
            const u = account.user.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const p = account.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            loginTag = tag(`LOGIN "${u}" "${p}"`);
          }
        } else if (phase === 'login') {
          if (line.startsWith(loginTag + ' OK')) { phase = 'select'; selectTag = tag(`SELECT "${account.folder}"`); }
          else if (line.startsWith('+ ') && resolvedToken) { socket.write('\r\n'); }
          else if (!line.startsWith(loginTag + ' OK') && line.startsWith(loginTag + ' ')) {
            finish({ success: false, error: imapLoginError(line.slice(loginTag.length + 1)) }); return;
          }
        } else if (phase === 'select') {
          if (line.startsWith(selectTag + ' OK')) {
            phase = 'fetch';
            fetchTag = tag(`FETCH ${seqNum} (BODY.PEEK[TEXT])`);
          } else if (line.match(new RegExp(`^${selectTag} (NO|BAD)`))) {
            finish({ success: false, error: `SELECT fehlgeschlagen` }); return;
          }
        } else if (phase === 'fetch') {
          fetchBuf += line + '\r\n';
          if (line.startsWith(fetchTag + ' OK')) {
            phase = 'done';
            // Extract literal: {N}\r\n[N bytes]
            const litMatch = fetchBuf.match(/\{(\d+)\}\r\n/);
            let text = '';
            if (litMatch) {
              const litStart = fetchBuf.indexOf(litMatch[0]) + litMatch[0].length;
              const litSize = parseInt(litMatch[1]);
              text = fetchBuf.slice(litStart, litStart + litSize);
              if (text.includes('<html') || text.includes('<!DOCTYPE')) text = stripHtml(text);
            }
            finish({ success: true, text: text.slice(0, 6000) }); // cap at 6k chars
          }
        }
      }
    });
  });
});

// ─── IMAP: list folders ───────────────────────────────────────────────────────
ipcMain.handle('list-mail-folders', async (_event, account: import('../shared/types').MailAccount): Promise<{ success: boolean; folders?: string[]; error?: string }> => {
  let resolvedToken: string | null = null;
  if (account.authType === 'oauth2') {
    try { resolvedToken = await getValidAccessToken(account); }
    catch (err) { return { success: false, error: (err as Error).message }; }
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { finish({ success: false, error: 'Timeout' }); }, 20000);
    let buf = '';
    const folders: string[] = [];
    let loginTag = '', listTag = '';
    let tagN = 0;
    const tag = (cmd: string) => { const t = `FL${++tagN}`; socket.write(`${t} ${cmd}\r\n`); return t; };
    type Phase = 'greeting' | 'login' | 'list' | 'done';
    let phase: Phase = 'greeting';

    const finish = (result: { success: boolean; folders?: string[]; error?: string }) => {
      clearTimeout(timeout);
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const connectOpts = { host: account.host, port: account.port, rejectUnauthorized: false };
    const socket = account.ssl
      ? tls.connect(connectOpts as tls.ConnectionOptions, () => {})
      : net.createConnection({ host: account.host, port: account.port });

    socket.on('error', (err: Error) => finish({ success: false, error: err.message }));

    socket.on('data', (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (phase === 'greeting') {
          if (line.startsWith('* OK')) {
            phase = 'login';
            if (resolvedToken) {
              const xoauth2 = Buffer.from(`user=${account.user}\x01auth=Bearer ${resolvedToken}\x01\x01`).toString('base64');
              loginTag = tag(`AUTHENTICATE XOAUTH2 ${xoauth2}`);
            } else {
              const u = account.user.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              const p = account.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
              loginTag = tag(`LOGIN "${u}" "${p}"`);
            }
          }
        } else if (phase === 'login') {
          if (line.startsWith(loginTag + ' OK')) {
            phase = 'list';
            listTag = tag('LIST "" "*"');
          } else if (line.startsWith('+ ') && resolvedToken) {
            socket.write('\r\n');
          } else if (line.startsWith(loginTag + ' ') && !line.startsWith(loginTag + ' OK')) {
            finish({ success: false, error: imapLoginError(line.slice(loginTag.length + 1)) }); return;
          }
        } else if (phase === 'list') {
          if (line.startsWith('* LIST')) {
            // * LIST (\flags) "/" "Name" or * LIST (\flags) "/" Name
            const m = line.match(/\* LIST \([^)]*\) (?:"[^"]*"|NIL) (.+)$/);
            if (m) {
              const name = m[1].replace(/^"|"$/g, '').trim();
              if (name && name !== 'NIL') folders.push(name);
            }
          } else if (line.startsWith(listTag + ' OK')) {
            finish({ success: true, folders });
          } else if (line.startsWith(listTag + ' NO') || line.startsWith(listTag + ' BAD')) {
            finish({ success: false, error: `LIST fehlgeschlagen: ${line}` });
          }
        }
      }
    });
  });
});

// ─── Ollama: list models ──────────────────────────────────────────────────────
ipcMain.handle('ollama-list-models', async (_event, ollamaUrl: string): Promise<{ success: boolean; models?: string[]; error?: string }> => {
  try {
    const raw = await ollamaGet(ollamaUrl, '/api/tags');
    const json = JSON.parse(raw);
    const models: string[] = (json.models ?? []).map((m: { name: string }) => m.name);
    return { success: true, models };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Ollama: analyze (streaming) ─────────────────────────────────────────────
ipcMain.handle('ollama-analyze', async (event, ollamaUrl: string, model: string, systemPrompt: string, userMessage: string): Promise<{ success: boolean; error?: string }> => {
  return new Promise((resolve) => {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
    };
    ollamaStream(
      ollamaUrl, body,
      (text) => { try { event.sender.send('ollama-chunk', { text }); } catch { /* renderer gone */ } },
      () => { try { event.sender.send('ollama-chunk', { done: true }); } catch { /* renderer gone */ } resolve({ success: true }); },
      (err) => { try { event.sender.send('ollama-chunk', { done: true, error: err.message }); } catch { /* renderer gone */ } resolve({ success: false, error: err.message }); }
    );
  });
});

// ─── Ollama: non-streaming POST helper ───────────────────────────────────────
function ollamaPost(urlStr: string, body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const base = new URL('/api/chat', urlStr);
    const mod = getHttpModule(urlStr);
    const bodyStr = JSON.stringify(body);
    const port = base.port ? parseInt(base.port) : (base.protocol === 'https:' ? 443 : 80);
    const req = (mod as typeof http).request({
      hostname: base.hostname, port, path: base.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c.toString());
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─── Ollama: classify mail batch ──────────────────────────────────────────────
ipcMain.handle('ollama-classify-mail', async (event, ollamaUrl: string, model: string, emails: Array<{ uid: number; from: string; subject: string }>) => {
  const CATEGORIES = ['URGENT', 'ACTION', 'FYI', 'NOISE'] as const;
  const SYSTEM = [
    'You are an email classifier. Classify the email and reply with ONLY one word.',
    'URGENT = needs immediate reply or action today (deadlines, emergencies, urgent requests)',
    'ACTION = needs follow-up or action, but not today (tasks, questions, requests)',
    'FYI = informational only, no action needed (reports, confirmations, updates)',
    'NOISE = newsletter, marketing, automated notification, spam',
    'Reply with ONLY the single word: URGENT, ACTION, FYI, or NOISE.',
  ].join('\n');
  const results: { uid: number; category: string }[] = [];
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    let category = 'FYI';
    try {
      const raw = await ollamaPost(ollamaUrl, {
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}` },
        ],
        stream: false,
        options: { temperature: 0.1 }, // low temperature for consistent classification
      });
      const parsed = JSON.parse(raw);
      const content = (parsed.message?.content ?? parsed.response ?? '').trim();
      const firstWord = content.split(/[\s\n.,;:!?]+/)[0].toUpperCase();
      category = (CATEGORIES as readonly string[]).find(c => c === firstWord)
        ?? (CATEGORIES as readonly string[]).find(c => content.toUpperCase().includes(c))
        ?? 'FYI';
      console.log(`[classify] uid=${email.uid} subject="${email.subject.slice(0,40)}" → raw="${content.slice(0,30)}" → ${category}`);
    } catch (err) {
      console.error(`[classify] uid=${email.uid} error:`, err);
    }
    results.push({ uid: email.uid, category });
    try { event.sender.send('classify-mail-progress', { done: i + 1, total: emails.length, uid: email.uid, category }); } catch { /* renderer gone */ }
  }
  return results;
});

ipcMain.handle('test-mail-connection', async (_event, account: import('../shared/types').MailAccount): Promise<import('../shared/types').MailConnectionResult> => {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Verbindungs-Timeout (10s)' });
    }, 10000);

    const onGreeting = (greeting: string) => {
      clearTimeout(timeout);
      if (greeting.startsWith('* OK')) {
        resolve({ success: true, greeting: greeting.trim() });
      } else {
        resolve({ success: false, error: greeting.trim() });
      }
    };

    const onError = (err: Error) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    };

    try {
      if (account.ssl) {
        const sock = tls.connect({ host: account.host, port: account.port, rejectUnauthorized: false }, () => {
          sock.once('data', (data) => {
            onGreeting(data.toString());
            sock.destroy();
          });
        });
        sock.once('error', onError);
      } else {
        const sock = net.createConnection({ host: account.host, port: account.port }, () => {
          sock.once('data', (data) => {
            onGreeting(data.toString());
            sock.destroy();
          });
        });
        sock.once('error', onError);
      }
    } catch (err) {
      clearTimeout(timeout);
      resolve({ success: false, error: (err as Error).message });
    }
  });
});
