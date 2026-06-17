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
import { promisify } from 'util';
const execAsync = promisify(exec);
import * as pty from 'node-pty';
import { whatsAppService, WhatsAppConfig } from './whatsapp-service';
import { vaultSet, vaultGet, vaultHas, vaultDelete, vaultDeletePrefix, VAULT_SENTINEL } from './vault';
import { startCliServer, pickTaskServerForHint, type CliServerState } from './cli-server';
import { detectVaultPath, updateProjectWiki, getGitChanges, updateCoworkVaultWiki, regenerateFullVaultIndexWithCowork, updateCoworkVaultIndexEntry, updateProjectVaultIndexEntry, updateVaultWiki, extractDescription } from './wiki-generator';
import * as playwrightService from './playwright-service';
import type { WikiSettings, Todo, PasswordEntry, GitHubAccount } from '../shared/types';

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
async function getGitBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function isGitDirty(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Cowork Git helper functions
// When ClaudeMC provides its own GIT_ASKPASS (= we know the right token),
// we must DISABLE the system credential.helper. Otherwise git pulls a stale
// token from macOS Keychain before it even asks ASKPASS, and the call fails
// with the wrong account.
const GIT_NO_HELPER = '-c credential.helper= -c credential.useHttpPath=false';

async function gitFetch(repoPath: string, remote: string, env: Record<string, string> = {}): Promise<{ success: boolean; error?: string }> {
  try {
    const helperOverride = env.GIT_ASKPASS ? GIT_NO_HELPER : '';
    await execAsync(`git ${helperOverride} fetch ${remote}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function getAheadBehind(repoPath: string, remote: string, branch: string): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execAsync(`git rev-list --left-right --count ${remote}/${branch}...HEAD`, {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    const parts = stdout.trim().split(/\s+/);
    return {
      behind: parseInt(parts[0], 10) || 0,
      ahead: parseInt(parts[1], 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function getChangedFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    if (!stdout.trim()) return [];
    // Exclude lock file from changed files list - it's handled automatically by lock system
    return stdout.trim().split('\n')
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

async function gitPull(repoPath: string, remote: string, branch: string, env: Record<string, string> = {}): Promise<{ success: boolean; error?: string; conflicts?: ConflictInfo[] }> {
  const mergedEnv = { ...process.env, ...env };
  const helperOverride = env.GIT_ASKPASS ? GIT_NO_HELPER : '';
  try {
    // Try pull with --rebase --autostash to handle divergent branches cleanly
    await execAsync(`git ${helperOverride} pull --rebase --autostash ${remote} ${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      env: mergedEnv,
    });
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message || '';

    // Check if the error is due to local changes (like .deployment.json)
    if (errorMsg.includes('local changes') || errorMsg.includes('would be overwritten')) {
      try {
        // Save local versions of changed files
        const { stdout: diffOut } = await execAsync('git diff --name-only', { cwd: repoPath, encoding: 'utf-8' });
        const changedFiles = diffOut.trim().split('\n').filter(f => f);

        const localVersions: Record<string, string> = {};
        for (const file of changedFiles) {
          try {
            localVersions[file] = await fs.promises.readFile(path.join(repoPath, file), 'utf-8');
          } catch { /* file might not exist */ }
        }

        // Stash local changes
        await execAsync('git stash push -m "auto-stash before pull"', { cwd: repoPath, encoding: 'utf-8' });

        // Pull the remote changes
        await execAsync(`git ${helperOverride} pull ${remote} ${branch}`, { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });

        // Get remote versions
        const remoteVersions: Record<string, string> = {};
        for (const file of changedFiles) {
          try {
            remoteVersions[file] = await fs.promises.readFile(path.join(repoPath, file), 'utf-8');
          } catch { /* file might not exist */ }
        }

        // Try to restore stash
        try {
          await execAsync('git stash pop', { cwd: repoPath, encoding: 'utf-8' });
        } catch {
          // Stash pop had conflicts - handle them smartly
          const { stdout: conflictOut } = await execAsync('git diff --name-only --diff-filter=U', { cwd: repoPath, encoding: 'utf-8' });
          const conflictFiles = conflictOut.trim().split('\n').filter(f => f);

          const conflicts: ConflictInfo[] = [];

          for (const file of conflictFiles) {
            const localContent = localVersions[file] || '';
            const remoteContent = remoteVersions[file] || '';

            // Smart merge for .deployment.json
            if (file === '.deployment.json') {
              const merged = smartMergeDeploymentConfig(localContent, remoteContent);
              await fs.promises.writeFile(path.join(repoPath, file), merged, 'utf-8');
              console.log(`[Git] Smart-merged ${file}`);
            } else {
              // For other files, collect conflict info for UI
              conflicts.push({ file, localContent, remoteContent });
              // For now, keep local version
              await fs.promises.writeFile(path.join(repoPath, file), localContent, 'utf-8');
            }
          }

          // Reset and drop stash
          try {
            await execAsync('git reset HEAD', { cwd: repoPath });
            await execAsync('git stash drop', { cwd: repoPath });
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

async function gitForcePull(repoPath: string, remote: string, branch: string, env: Record<string, string> = {}): Promise<{ success: boolean; error?: string }> {
  const mergedEnv = { ...process.env, ...env };
  const helperOverride = env.GIT_ASKPASS ? GIT_NO_HELPER : '';
  try {
    await execAsync(`git ${helperOverride} fetch ${remote} ${branch}`, { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });
    // Hard-reset to the fetched remote tip: discards uncommitted tracked changes
    // and resolves any divergence. Untracked files are left untouched (no git clean).
    await execAsync(`git reset --hard ${remote}/${branch}`, { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function gitCommitAndPush(repoPath: string, message: string, remote: string, branch: string, env: Record<string, string> = {}): Promise<{ success: boolean; error?: string }> {
  const mergedEnv = { ...process.env, ...env };
  const helperOverride = env.GIT_ASKPASS ? GIT_NO_HELPER : '';
  try {
    await execAsync('git add -A', { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });
    await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });
    await execAsync(`git ${helperOverride} push ${remote} ${branch}`, { cwd: repoPath, encoding: 'utf-8', env: mergedEnv });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function hasConflicts(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    // Check for unmerged files (conflicts)
    return stdout.trim().split('\n').some((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'));
  } catch {
    return false;
  }
}

async function getConflictFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    // Get files with unmerged status (UU, AA, DD)
    return stdout.trim().split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

async function getConflictDetails(repoPath: string): Promise<ConflictInfo[]> {
  const conflictFiles = await getConflictFiles(repoPath);
  const conflicts: ConflictInfo[] = [];

  for (const file of conflictFiles) {
    const filePath = path.join(repoPath, file);
    try {
      // Get the current file content (with conflict markers)
      const content = await fs.promises.readFile(filePath, 'utf-8');

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
          const { stdout } = await execAsync(`git show :2:${file}`, { cwd: repoPath, encoding: 'utf-8' });
          localContent = stdout;
        } catch {
          localContent = '(Datei nicht verfügbar)';
        }
        try {
          const { stdout } = await execAsync(`git show :3:${file}`, { cwd: repoPath, encoding: 'utf-8' });
          remoteContent = stdout;
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
let cliServerState: CliServerState | null = null;
let forceQuit = false;
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
  sessionId?: string;
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
  projects: Array<{ path: string; name: string; type?: 'tools' | 'projekt'; description?: string }>;
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

  mainWindow.on('close', async (event) => {
    if (forceQuit) return;

    const ptyCount = ptyProcesses.size;
    if (ptyCount === 0) return;

    event.preventDefault();

    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Trotzdem beenden', 'Abbrechen'],
      defaultId: 1,
      cancelId: 1,
      title: 'App schließen?',
      message: 'Es gibt noch offene Aktivitäten:',
      detail: `• ${ptyCount} aktive${ptyCount === 1 ? ' Terminal-Session' : ' Terminal-Sessions'} (werden beendet)`,
    });

    if (response === 0) {
      forceQuit = true;
      mainWindow?.destroy();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Set main window for WhatsApp service
  whatsAppService.setMainWindow(mainWindow);
}

// Test-Notification: fires unconditionally (even when window is focused) so the
// user can verify the macOS permission flow. The first call after install will
// trigger the system permission dialog if the user has never granted it.
ipcMain.handle('send-test-notification', async (): Promise<{ supported: boolean; shown: boolean; error?: string }> => {
  if (!Notification.isSupported()) {
    return { supported: false, shown: false, error: 'Notifications werden auf diesem System nicht unterstützt' };
  }
  try {
    const notif = new Notification({
      title: 'Claude MC',
      body: 'Test-Benachrichtigung — funktioniert! 🎉',
      silent: false,
    });
    notif.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    notif.show();
    return { supported: true, shown: true };
  } catch (err) {
    return { supported: true, shown: false, error: (err as Error).message };
  }
});

// Save a Playwright script as a project task (`<project>/tasks/<name>.js`).
// Path-traversal guarded against the registered project/cowork roots.
ipcMain.handle('playwright-save-as-project-task', async (_event, opts: {
  projectPath: string;
  taskName: string;
  code: string;
  description?: string;
  serverHint?: string;
}): Promise<{ success: boolean; filePath?: string; error?: string }> => {
  try {
    const projectsCfg = await loadProjectConfig();
    const coworkCfg = await loadCoworkConfig();
    const allRoots = [
      ...projectsCfg.projects.map(p => path.resolve(p.path)),
      ...coworkCfg.repositories.map(r => path.resolve(r.localPath)),
    ];
    const target = path.resolve(opts.projectPath);
    if (!allRoots.includes(target)) {
      return { success: false, error: 'Projektpfad nicht registriert' };
    }
    const safe = opts.taskName.replace(/[^\w.-]+/g, '-').toLowerCase() || `playwright-${Date.now()}`;
    const filename = safe.endsWith('.js') ? safe : `${safe}.js`;
    const tasksDir = path.join(target, 'tasks');
    await fs.promises.mkdir(tasksDir, { recursive: true });
    const filePath = path.join(tasksDir, filename);
    // Re-use existing frontmatter style. Only add a header if user code doesn't
    // already declare one — we don't want to duplicate `@desc:` lines.
    const hasFrontmatter = /^\s*\/\/\s*@\w+\s*:/m.test(opts.code.split('\n').slice(0, 10).join('\n'));
    const header = hasFrontmatter ? '' : [
      opts.description ? `// @desc: ${opts.description}` : '',
      opts.serverHint ? `// @server: ${opts.serverHint}` : '',
    ].filter(Boolean).join('\n') + (opts.description || opts.serverHint ? '\n\n' : '');
    await fs.promises.writeFile(filePath, header + opts.code, 'utf-8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// --- PlaywrightMC IPC handlers --------------------------------------------
ipcMain.handle('playwright-install-status', async () => playwrightService.getInstallStatus());
ipcMain.handle('playwright-install-chromium', async () => playwrightService.installChromium(mainWindow));
ipcMain.handle('playwright-open-browser', async (_event, url: string) => playwrightService.openBrowser(url));
ipcMain.handle('playwright-close-browser', async () => playwrightService.closeBrowser());
ipcMain.handle('playwright-browser-state', async () => playwrightService.getBrowserState());
ipcMain.handle('playwright-screenshot', async (_event, savePath?: string) => playwrightService.takeScreenshot(savePath));
ipcMain.handle('playwright-pdf', async (_event, savePath?: string) => playwrightService.savePdf(savePath));
ipcMain.handle('playwright-dump-html', async () => playwrightService.dumpHtml());
ipcMain.handle('playwright-eval', async (_event, code: string) => playwrightService.evalJs(code));
ipcMain.handle('playwright-list-scripts', async () => playwrightService.listScripts());
ipcMain.handle('playwright-get-script', async (_event, id: string) => playwrightService.getScript(id));
ipcMain.handle('playwright-save-script', async (_event, input: { id?: string; name: string; code: string; description?: string }) => playwrightService.saveScript(input));
ipcMain.handle('playwright-delete-script', async (_event, id: string) => playwrightService.deleteScript(id));
ipcMain.handle('playwright-run-script', async (_event, scriptId: string) => playwrightService.runScript(mainWindow, scriptId));
ipcMain.handle('playwright-kill-run', async (_event, runId: string) => playwrightService.killRun(runId));
ipcMain.handle('playwright-start-codegen', async (_event, opts: { url: string; scriptName: string }) => playwrightService.startCodegen(mainWindow, opts));

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
    // Migrate plaintext passwords from mail-accounts.json to vault
    try {
      const accounts = loadMailAccounts();
      let changed = false;
      for (const acc of accounts) {
        if (acc.password && acc.password !== VAULT_SENTINEL) {
          vaultSet(`mail:${acc.id}:password`, acc.password);
          acc.password = VAULT_SENTINEL;
          changed = true;
          console.log(`[vault] Migrated password for mail account ${acc.id}`);
        }
      }
      if (changed) saveMailAccounts(accounts);
    } catch (err) {
      console.warn('[vault] Migration failed:', (err as Error).message);
    }
    // Apply projekt template to cowork repos without CLAUDE.md
    await applyTemplateToCoworkRepos();

    // Best-effort: sync the RTaskMC skill section in every project's CLAUDE.md
    // so any Claude reading the file picks up "you have these remote tasks".
    try {
      const cfg = await loadProjectConfig();
      const coCfg = await loadCoworkConfig();
      for (const p of cfg.projects) {
        await syncClaudeMdTasksSection(p.path).catch(() => null);
      }
      for (const r of coCfg.repositories) {
        await syncClaudeMdTasksSection(r.localPath).catch(() => null);
      }
    } catch (err) {
      console.warn('[rtaskmc] CLAUDE.md sync failed:', (err as Error).message);
    }

    // Install `claudemc-task` CLI symlink to ~/.local/bin (best-effort, may fail silently)
    try {
      const binDir = path.join(os.homedir(), '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const linkPath = path.join(binDir, 'claudemc-task');
      const isDev = !app.isPackaged;
      // In dev: point at repo source; in production: ship inside .app bundle
      const cliSource = isDev
        ? path.join(app.getAppPath(), 'tools', 'claudemc-task.js')
        : path.join(process.resourcesPath, 'tools', 'claudemc-task.js');
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
      if (fs.existsSync(cliSource)) {
        fs.symlinkSync(cliSource, linkPath);
        console.log(`[cli] symlinked ${linkPath} → ${cliSource}`);
      } else {
        console.warn(`[cli] CLI source not found at ${cliSource}`);
      }
    } catch (err) {
      console.warn('[cli] symlink failed:', (err as Error).message);
    }

    // Start the local CLI server (used by `claudemc-task` CLI and sub-agents)
    try {
      cliServerState = await startCliServer({
        onListTasks: async (projectPath: string) => {
          // Reuse the project-task scanner — filter to this project
          const all = await new Promise<import('../shared/types').ProjectTask[]>((resolve) => {
            // Inline scan: glob projectPath/tasks/*.sh and parse frontmatter
            (async () => {
              const tasksDir = path.join(projectPath, 'tasks');
              const out: import('../shared/types').ProjectTask[] = [];
              let entries: string[];
              try { entries = await fs.promises.readdir(tasksDir); } catch { return resolve([]); }
              for (const entry of entries) {
                const isBash = entry.endsWith('.sh');
                const isNode = entry.endsWith('.js');
                if (!isBash && !isNode) continue;
                const scriptPath = path.join(tasksDir, entry);
                let content = '';
                try { content = await fs.promises.readFile(scriptPath, 'utf-8'); } catch { /* empty */ }
                const meta = parseTaskFrontmatter(content);
                out.push({
                  projectPath,
                  projectName: path.basename(projectPath),
                  projectType: 'project',
                  taskName: entry.replace(/\.(sh|js)$/, ''),
                  scriptPath,
                  language: detectTaskLanguage(entry),
                  description: meta.description,
                  serverHint: meta.serverHint,
                  envHints: meta.envHints,
                });
              }
              resolve(out);
            })();
          });
          return all.map(t => ({ taskName: t.taskName, description: t.description, serverHint: t.serverHint }));
        },
        onGetJob: async (jobId: string) => {
          // Try every registered task-server until one knows the job (single-server-typical, but supports multi)
          const servers = await loadTaskServers();
          for (const srv of servers) {
            const token = vaultGet(`tasksrv:${srv.id}:token`);
            if (!token) continue;
            try {
              const r = await taskServerRequest(srv.baseUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`) as { __status?: number; id?: string };
              if (r?.__status === 404) continue;
              if (r?.__status) return { error: `Task-Server HTTP ${r.__status}` };
              if (r?.id) return { job: r };
            } catch (err) {
              return { error: (err as Error).message };
            }
          }
          return { error: 'Job nicht gefunden' };
        },
        onStreamJobLog: async (jobId: string, res) => {
          // Find which server owns the job, then pipe its SSE log to `res`
          const servers = await loadTaskServers();
          let target: { url: string; token: string } | null = null;
          for (const srv of servers) {
            const token = vaultGet(`tasksrv:${srv.id}:token`);
            if (!token) continue;
            try {
              const r = await taskServerRequest(srv.baseUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`) as { __status?: number; id?: string };
              if (r?.id) { target = { url: srv.baseUrl, token }; break; }
            } catch { /* try next */ }
          }
          if (!target) {
            res.write(`event: end\ndata: ${JSON.stringify({ error: 'Job nicht gefunden' })}\n\n`);
            res.end();
            return;
          }
          // Open upstream SSE and pipe raw bytes through
          const u = new URL(`/jobs/${encodeURIComponent(jobId)}/log`, target.url);
          const lib = u.protocol === 'https:' ? https : http;
          const upstream = lib.request({
            method: 'GET',
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            headers: { 'Authorization': `Bearer ${target.token}`, 'Accept': 'text/event-stream' },
          }, (ures) => {
            if (ures.statusCode !== 200) {
              res.write(`event: end\ndata: ${JSON.stringify({ error: `HTTP ${ures.statusCode}` })}\n\n`);
              res.end();
              return;
            }
            ures.pipe(res);
          });
          upstream.on('error', (err) => {
            try { res.write(`event: end\ndata: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch { /* ignore */ }
          });
          // Client disconnect → kill upstream too
          res.on('close', () => { try { upstream.destroy(); } catch { /* ignore */ } });
          upstream.end();
        },
        onRunTask: async ({ projectPath, taskName, source, env }) => {
          // 1) locate script — prefer .sh, fall back to .js
          const tasksDir = path.join(projectPath, 'tasks');
          let scriptPath = path.join(tasksDir, `${taskName}.sh`);
          let content: string | null = null;
          try { content = await fs.promises.readFile(scriptPath, 'utf-8'); }
          catch { /* try .js */ }
          if (content === null) {
            scriptPath = path.join(tasksDir, `${taskName}.js`);
            try { content = await fs.promises.readFile(scriptPath, 'utf-8'); }
            catch { return { error: `Task nicht gefunden: ${taskName}(.sh|.js)` }; }
          }
          const language = detectTaskLanguage(scriptPath);
          // 2) figure out which task-server to use
          const fm = parseTaskFrontmatter(content);
          const servers = await loadTaskServers();
          const target = pickTaskServerForHint(servers, fm.serverHint);
          if (!target) return { error: 'Kein Task-Server konfiguriert' };
          const server = servers.find(s => s.name === target.name);
          if (!server) return { error: 'Server-Lookup fehlgeschlagen' };
          const token = vaultGet(`tasksrv:${server.id}:token`);
          if (!token) return { error: 'Kein Token im Vault für diesen Server' };
          // 3) POST to task-server with meta + optional env (secrets — not logged)
          const meta = {
            projectId: projectPath.replace(/\//g, '-'),
            projectName: path.basename(projectPath),
            taskName,
            source: source || 'cli',
          };
          const body: Record<string, unknown> = { script: content, language, name: taskName, meta };
          if (env && Object.keys(env).length > 0) body.env = env;
          try {
            const res = await taskServerRequest(server.baseUrl, token, 'POST', '/jobs', body) as { id?: string; __status?: number; __body?: unknown };
            if (res?.__status) return { error: `Task-Server HTTP ${res.__status}: ${JSON.stringify(res.__body)}` };
            if (!res?.id) return { error: 'Task-Server lieferte keine Job-ID' };
            return { jobId: res.id, serverUrl: server.baseUrl, serverName: server.name };
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      });
    } catch (err) {
      console.error('[cli-server] failed to start:', err);
    }
  });

  // Shut down the local CLI server on quit
  app.on('will-quit', () => {
    try { cliServerState?.shutdown(); } catch { /* ignore */ }
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
    let claudeMdContent: string | undefined;
    if (exists) {
      try {
        claudeMdContent = await fs.promises.readFile(path.join(p.path, 'CLAUDE.md'), 'utf-8');
        hasClaudeMd = true;
      } catch {
        // No CLAUDE.md
      }
    }

    const gitBranch = exists ? await getGitBranch(p.path) : undefined;
    const gitDirty = gitBranch ? await isGitDirty(p.path) : false;

    const manualDesc = p.description?.trim();
    const autoDesc = hasClaudeMd ? extractDescription(claudeMdContent, 120) : '';
    const description = manualDesc || (autoDesc && autoDesc !== '-' ? autoDesc : '');

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
      description,
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

  const gitBranch = await getGitBranch(projectPath);
  const gitDirty = gitBranch ? await isGitDirty(projectPath) : false;

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

  const gitBranch = await getGitBranch(projectPath);
  const gitDirty = gitBranch ? await isGitDirty(projectPath) : false;

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

// ── Project Export / Import ──────────────────────────────────────────────────
// Bundle contains the ClaudeMC-specific configuration for a project (NOT the
// source code, NOT credentials). Recipient picks a local folder, ClaudeMC
// writes the bundled CLAUDE.md / claudemc.md / settings into it and registers
// the project. Use case: hand a configured project over to another ClaudeMC
// user who already has the code (cowork / git clone).
interface ClaudeMcExportV1 {
  claudemcExport: 'v1';
  exportedAt: string;
  exporterVersion: string;
  project: {
    name: string;
    type: 'tools' | 'projekt';
    description?: string;
    originalPath: string;
    originalProjectId: string;
  };
  files: { [name: string]: string | null };
  settings: { [name: string]: unknown };
}

ipcMain.handle('export-project', async (_event, projectPath: string): Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }> => {
  const config = await loadProjectConfig();
  const project = config.projects.find(p => p.path === projectPath);
  if (!project) return { success: false, error: 'Projekt nicht in der Konfiguration gefunden' };

  const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'projekt';
  const saveResult = await dialog.showSaveDialog(mainWindow!, {
    title: 'ClaudeMC Projekt exportieren',
    defaultPath: `${safeName}-claudemc.json`,
    filters: [{ name: 'ClaudeMC Export', extensions: ['json'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

  const readText = async (filename: string): Promise<string | null> => {
    try { return await fs.promises.readFile(path.join(projectPath, filename), 'utf8'); } catch { return null; }
  };
  const readJson = async (filepath: string): Promise<unknown | null> => {
    try { return JSON.parse(await fs.promises.readFile(filepath, 'utf8')); } catch { return null; }
  };

  const projectId = projectPath.replace(/\//g, '-');
  const settingsDir = path.join(os.homedir(), '.claude', 'projects', projectId);

  const bundle: ClaudeMcExportV1 = {
    claudemcExport: 'v1',
    exportedAt: new Date().toISOString(),
    exporterVersion: app.getVersion(),
    project: {
      name: project.name,
      type: project.type ?? 'projekt',
      description: project.description,
      originalPath: project.path,
      originalProjectId: projectId,
    },
    files: {
      'CLAUDE.md': await readText('CLAUDE.md'),
      'claudemc.md': await readText('claudemc.md'),
    },
    settings: {
      'settings.local.json': await readJson(path.join(settingsDir, 'settings.local.json')),
      'wiki-settings.json': await readJson(path.join(settingsDir, 'wiki-settings.json')),
    },
  };

  try {
    await fs.promises.writeFile(saveResult.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    await addLogEntry('activity', `Projekt exportiert: ${project.name}`, saveResult.filePath);
    return { success: true, path: saveResult.filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('import-project', async (): Promise<{ success: boolean; project?: unknown; error?: string; canceled?: boolean }> => {
  const openResult = await dialog.showOpenDialog(mainWindow!, {
    title: 'ClaudeMC Export-Datei wählen',
    filters: [{ name: 'ClaudeMC Export', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (openResult.canceled || openResult.filePaths.length === 0) return { success: false, canceled: true };

  let bundle: ClaudeMcExportV1;
  try {
    const raw = await fs.promises.readFile(openResult.filePaths[0], 'utf8');
    bundle = JSON.parse(raw) as ClaudeMcExportV1;
  } catch {
    return { success: false, error: 'Datei konnte nicht gelesen werden' };
  }
  if (bundle.claudemcExport !== 'v1' || !bundle.project?.name) {
    return { success: false, error: 'Unbekanntes oder beschädigtes Export-Format' };
  }

  const targetResult = await dialog.showOpenDialog(mainWindow!, {
    title: `Zielordner für "${bundle.project.name}" wählen`,
    buttonLabel: 'Hierhin importieren',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (targetResult.canceled || targetResult.filePaths.length === 0) return { success: false, canceled: true };
  const targetPath = targetResult.filePaths[0];

  const config = await loadProjectConfig();
  if (config.projects.some(p => p.path === targetPath)) {
    return { success: false, error: 'Dieser Pfad ist bereits als Projekt registriert' };
  }

  const writeTextFile = async (name: string, content: string | null | undefined) => {
    if (content == null) return;
    const filePath = path.join(targetPath, name);
    try {
      const existing = await fs.promises.readFile(filePath, 'utf8').catch(() => null);
      if (existing !== null && existing !== content) {
        await fs.promises.copyFile(filePath, `${filePath}.bak-${Date.now()}`);
      }
      await fs.promises.writeFile(filePath, content, 'utf8');
    } catch (err) {
      console.error(`[Import] write ${name} failed:`, err);
    }
  };
  await writeTextFile('CLAUDE.md', bundle.files?.['CLAUDE.md']);
  await writeTextFile('claudemc.md', bundle.files?.['claudemc.md']);

  const newProjectId = targetPath.replace(/\//g, '-');
  const settingsDir = path.join(os.homedir(), '.claude', 'projects', newProjectId);
  await fs.promises.mkdir(settingsDir, { recursive: true });
  for (const [name, value] of Object.entries(bundle.settings ?? {})) {
    if (value == null) continue;
    try {
      await fs.promises.writeFile(path.join(settingsDir, name), JSON.stringify(value, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Import] write settings ${name} failed:`, err);
    }
  }

  const projectType: 'tools' | 'projekt' = bundle.project.type === 'tools' ? 'tools' : 'projekt';
  config.projects.push({
    path: targetPath,
    name: bundle.project.name,
    type: projectType,
    ...(bundle.project.description ? { description: bundle.project.description } : {}),
  });
  await saveProjectConfig(config);

  await addLogEntry('activity', `Projekt importiert: ${bundle.project.name}`, targetPath);

  const gitBranch = await getGitBranch(targetPath);
  const gitDirty = gitBranch ? await isGitDirty(targetPath) : false;
  return {
    success: true,
    project: {
      id: newProjectId,
      path: targetPath,
      name: bundle.project.name,
      parentPath: path.dirname(targetPath),
      hasClaudeMd: bundle.files?.['CLAUDE.md'] != null,
      gitBranch,
      gitDirty,
      type: projectType,
      description: bundle.project.description,
    },
  };
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

ipcMain.handle('update-project-description', async (_event, projectPath: string, description: string) => {
  const config = await loadProjectConfig();
  const project = config.projects.find((p) => p.path === projectPath);
  if (!project) return { success: false, error: 'Projekt nicht gefunden' };
  const trimmed = description.trim();
  if (trimmed) {
    project.description = trimmed;
  } else {
    delete project.description;
  }
  await saveProjectConfig(config);
  return { success: true };
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
      gitBranch = await getGitBranch(projectPath) || undefined;
      gitDirty = gitBranch ? await isGitDirty(projectPath) : false;
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
        gitBranch = await getGitBranch(projectPath) || undefined;
        gitDirty = gitBranch ? await isGitDirty(projectPath) : false;
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
      gitBranch = await getGitBranch(projectPath) || undefined;
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
              pGitBranch = await getGitBranch(pPath) || undefined;
              pGitDirty = pGitBranch ? await isGitDirty(pPath) : false;
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

  // Enrich shell env so `claudemc-task` CLI works from terminal Claude / interactive shell
  const ptyEnv: { [key: string]: string } = {
    ...process.env as { [key: string]: string },
    PATH: [
      path.join(os.homedir(), '.local', 'bin'),
      process.env.PATH,
      '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
    ].filter(Boolean).join(':'),
    CLAUDEMC_PROJECT_PATH: cwd,
  };
  if (cliServerState) {
    ptyEnv.CLAUDEMC_API = cliServerState.apiUrl;
    ptyEnv.CLAUDEMC_TOKEN = cliServerState.token;
  }

  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: cwd,
    env: ptyEnv,
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

// Run a script LOCALLY in a PTY tab (used as fallback when the remote task-server is offline).
// Writes the script to a temp file and spawns `bash <file>` so multiline scripts and quoting
// work without escaping. Tab dies when the script exits (user sees exit code).
ipcMain.handle('run-task-local', async (
  _event,
  tabId: string,
  script: string,
  cwd: string | null | undefined,
  cols: number = 80,
  rows: number = 24,
): Promise<{ success: boolean; error?: string }> => {
  const existingPty = ptyProcesses.get(tabId);
  if (existingPty) {
    existingPty.kill();
    ptyProcesses.delete(tabId);
  }

  const scriptId = crypto.randomUUID();
  const scriptPath = path.join(os.tmpdir(), `rtaskmc-local-${scriptId}.sh`);
  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  } catch (err) {
    return { success: false, error: `Konnte Script nicht ablegen: ${(err as Error).message}` };
  }

  const effectiveCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const ptyEnv: { [key: string]: string } = {
    ...process.env as { [key: string]: string },
    PATH: [
      path.join(os.homedir(), '.local', 'bin'),
      process.env.PATH,
      '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
    ].filter(Boolean).join(':'),
    JOB_ARTIFACT_DIR: effectiveCwd,
  };

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn('/bin/bash', [scriptPath], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: effectiveCwd,
      env: ptyEnv,
    });
  } catch (err) {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    return { success: false, error: `Spawn fehlgeschlagen: ${(err as Error).message}` };
  }

  ptyProcesses.set(tabId, ptyProcess);

  ptyProcess.onData((data) => {
    const existing = ptyDataBuffers.get(tabId);
    ptyDataBuffers.set(tabId, existing ? existing + data : data);
    if (!ptyDataTimers.has(tabId)) {
      ptyDataTimers.set(tabId, setTimeout(() => {
        ptyDataTimers.delete(tabId);
        const batch = ptyDataBuffers.get(tabId);
        if (batch) {
          ptyDataBuffers.delete(tabId);
          mainWindow?.webContents.send('pty-data', tabId, batch);
        }
      }, 8));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const exitTimer = ptyDataTimers.get(tabId);
    if (exitTimer !== undefined) {
      clearTimeout(exitTimer);
      ptyDataTimers.delete(tabId);
    }
    const remaining = ptyDataBuffers.get(tabId);
    if (remaining) {
      ptyDataBuffers.delete(tabId);
      mainWindow?.webContents.send('pty-data', tabId, remaining);
    }
    const exitMsg = `\r\n\x1b[2m[Task lokal beendet · exit ${exitCode}]\x1b[0m\r\n`;
    mainWindow?.webContents.send('pty-data', tabId, exitMsg);
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  });

  return { success: true };
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

// ── Cowork Smart-Merge / Sync-Resolver ────────────────────────────────────
// Detects three states the user may need to recover from:
//   1) stuck-rebase: a leftover .git/rebase-merge/ directory (interrupted pull --rebase)
//   2) conflicts:   files in unmerged state (`git ls-files -u` non-empty)
//   3) clean:       normal ahead/behind
interface SyncResolverState {
  state: 'clean' | 'stuck-rebase' | 'conflicts';
  branch?: string;
  stuckRebase?: {
    onto?: string;
    headName?: string;          // branch being rebased
    doneCount: number;
    remainingCount: number;
    nextCommitMsg?: string;
    doneCommits: string[];
    remainingCommits: string[];
  };
  conflicts?: Array<{ path: string; xy: string }>; // "UU", "AA", etc.
}

ipcMain.handle('cowork-detect-sync-state', async (_event, repoPath: string): Promise<SyncResolverState | { error: string }> => {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return { error: 'Kein Git-Repo' };

  // Check for stuck rebase first — it blocks everything else
  const rebaseMergeDir = path.join(repoPath, '.git', 'rebase-merge');
  const rebaseApplyDir = path.join(repoPath, '.git', 'rebase-apply');
  let rebaseDir: string | null = null;
  if (fs.existsSync(rebaseMergeDir)) rebaseDir = rebaseMergeDir;
  else if (fs.existsSync(rebaseApplyDir)) rebaseDir = rebaseApplyDir;

  if (rebaseDir) {
    const readSafe = (f: string) => { try { return fs.readFileSync(path.join(rebaseDir!, f), 'utf-8').trim(); } catch { return ''; } };
    const onto = readSafe('onto');
    const headName = readSafe('head-name').replace(/^refs\/heads\//, '');
    const doneRaw = readSafe('done');
    const todoRaw = readSafe('git-rebase-todo');
    // Parse "pick HASH msg" lines
    const parseList = (raw: string) => raw.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const m = /^(\w+)\s+(\w+)\s*(.*)$/.exec(l);
        return m ? `${m[1]} ${m[2].slice(0, 8)} ${m[3]}` : l;
      });
    const doneCommits = parseList(doneRaw);
    const remainingCommits = parseList(todoRaw);
    const nextCommitMsg = remainingCommits[0];

    let branch = '';
    try { branch = (await execAsync('git symbolic-ref --short HEAD 2>/dev/null || true', { cwd: repoPath })).stdout.trim(); } catch { /* detached */ }

    return {
      state: 'stuck-rebase',
      branch,
      stuckRebase: { onto, headName, doneCount: doneCommits.length, remainingCount: remainingCommits.length, nextCommitMsg, doneCommits, remainingCommits },
    };
  }

  // No rebase — check for unmerged paths
  try {
    const { stdout } = await execAsync('git status --porcelain=v1 -uno', { cwd: repoPath });
    const conflicts: Array<{ path: string; xy: string }> = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const p = line.slice(3);
      // Conflict status codes per git-status man page
      if (['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(xy)) {
        conflicts.push({ path: p, xy });
      }
    }
    if (conflicts.length > 0) {
      let branch = '';
      try { branch = (await execAsync('git symbolic-ref --short HEAD 2>/dev/null || true', { cwd: repoPath })).stdout.trim(); } catch { /* detached */ }
      return { state: 'conflicts', branch, conflicts };
    }
  } catch (err) {
    return { error: `git status: ${(err as Error).message}` };
  }

  let branch = '';
  try { branch = (await execAsync('git symbolic-ref --short HEAD 2>/dev/null || true', { cwd: repoPath })).stdout.trim(); } catch { /* detached */ }
  return { state: 'clean', branch };
});

ipcMain.handle('cowork-rebase-action', async (_event, repoPath: string, action: 'abort' | 'continue' | 'skip'): Promise<{ success: boolean; output?: string; error?: string }> => {
  if (!['abort', 'continue', 'skip'].includes(action)) return { success: false, error: 'Ungültige Aktion' };
  try {
    const { stdout, stderr } = await execAsync(`git rebase --${action}`, { cwd: repoPath, encoding: 'utf-8' });
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { success: false, error: (e.stdout || '') + (e.stderr || '') || e.message || 'git rebase fehlgeschlagen' };
  }
});

ipcMain.handle('get-cowork-sync-status', async (_event, localPath: string, remote: string, branch: string) => {
  // First fetch from remote
  const coworkCfg = await loadCoworkConfig();
  const coworkRepo = coworkCfg.repositories.find(r => r.localPath === localPath);
  const gitEnv = coworkRepo?.githubUrl ? await getGitCredentialEnv(coworkRepo.githubUrl) : {};
  const fetchResult = await gitFetch(localPath, remote, gitEnv);
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

  const { ahead, behind } = await getAheadBehind(localPath, remote, branch);
  const changedFiles = await getChangedFiles(localPath);
  const hasUncommittedChanges = changedFiles.length > 0;
  const conflicts = await hasConflicts(localPath);
  const conflictFiles = conflicts ? await getConflictFiles(localPath) : [];

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
  const coworkCfgPull = await loadCoworkConfig();
  const coworkRepoPull = coworkCfgPull.repositories.find(r => r.localPath === localPath);
  const gitEnvPull = coworkRepoPull?.githubUrl ? await getGitCredentialEnv(coworkRepoPull.githubUrl) : {};
  const result = await gitPull(localPath, remote, branch, gitEnvPull);
  if (result.success) {
    await addLogEntry('activity', `Cowork Pull: ${path.basename(localPath)}`);
  } else {
    await addLogEntry('error', `Cowork Pull fehlgeschlagen: ${result.error}`, path.basename(localPath));
  }
  return result;
});

ipcMain.handle('cowork-force-pull', async (_event, localPath: string, remote: string, branch: string) => {
  const coworkCfgFP = await loadCoworkConfig();
  const coworkRepoFP = coworkCfgFP.repositories.find(r => r.localPath === localPath);
  const gitEnvFP = coworkRepoFP?.githubUrl ? await getGitCredentialEnv(coworkRepoFP.githubUrl) : {};
  const result = await gitForcePull(localPath, remote, branch, gitEnvFP);
  if (result.success) {
    await addLogEntry('activity', `Cowork Force Pull (hard reset): ${path.basename(localPath)}`);
  } else {
    await addLogEntry('error', `Cowork Force Pull fehlgeschlagen: ${result.error}`, path.basename(localPath));
  }
  return result;
});

ipcMain.handle('cowork-commit-push', async (_event, localPath: string, message: string, remote: string, branch: string) => {
  const coworkCfgPush = await loadCoworkConfig();
  const coworkRepoPush = coworkCfgPush.repositories.find(r => r.localPath === localPath);
  const gitEnvPush = coworkRepoPush?.githubUrl ? await getGitCredentialEnv(coworkRepoPush.githubUrl) : {};
  const result = await gitCommitAndPush(localPath, message, remote, branch, gitEnvPush);
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
    const conflicts = await getConflictDetails(repoPath);
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
async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

// Get remote URL from local repo
async function getRemoteUrl(repoPath: string, remote: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git remote get-url ${remote}`, { cwd: repoPath, encoding: 'utf-8' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Get current branch name
async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Get first available remote (usually "origin")
async function getDefaultRemote(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote', { cwd: repoPath, encoding: 'utf-8' });
    const remotes = stdout.trim().split('\n').filter(Boolean);
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

      result.isGitRepo = await isGitRepository(localPath);
      if (!result.isGitRepo) {
        // Folder exists but is not a git repo - clone to default path instead
        result.localPath = defaultLocalPath;
        result.valid = true;
        result.needsClone = true;
        result.error = `Ordner "${localPath}" ist kein Git-Repository. Wird nach "${defaultLocalPath}" geklont.`;
        return result;
      }

      // Auto-detect remote and branch
      const detectedRemote = await getDefaultRemote(localPath) || 'origin';
      const detectedBranch = await getCurrentBranch(localPath) || 'main';
      result.detectedRemote = detectedRemote;
      result.detectedBranch = detectedBranch;

      // Check if remote URL matches
      const currentRemoteUrl = await getRemoteUrl(localPath, detectedRemote);
      result.currentRemoteUrl = currentRemoteUrl || undefined;

      // Normalize URLs for comparison
      const normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
      result.remoteMatch = currentRemoteUrl ? normalizeUrl(currentRemoteUrl) === normalizeUrl(githubUrl) : false;

      if (!result.remoteMatch && currentRemoteUrl) {
        result.error = `Remote URL stimmt nicht überein. Erwartet: ${githubUrl}, Gefunden: ${currentRemoteUrl}`;
        return result;
      }

      // Fetch and get sync status
      const fetchResult = await gitFetch(localPath, detectedRemote);
      if (fetchResult.success) {
        const { ahead, behind } = await getAheadBehind(localPath, detectedRemote, detectedBranch);
        const changedFiles = await getChangedFiles(localPath);
        const hasUncommittedChanges = changedFiles.length > 0;
        const conflicts = await hasConflicts(localPath);

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
      result.isGitRepo = await isGitRepository(defaultLocalPath);
      if (result.isGitRepo) {
        result.valid = true;
        result.needsClone = false;

        // Auto-detect remote and branch
        const detectedRemote = await getDefaultRemote(defaultLocalPath) || 'origin';
        const detectedBranch = await getCurrentBranch(defaultLocalPath) || 'main';
        result.detectedRemote = detectedRemote;
        result.detectedBranch = detectedBranch;

        // Fetch and get sync status
        const fetchResult = await gitFetch(defaultLocalPath, detectedRemote);
        if (fetchResult.success) {
          const { ahead, behind } = await getAheadBehind(defaultLocalPath, detectedRemote, detectedBranch);
          const changedFiles = await getChangedFiles(defaultLocalPath);
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
      await execAsync(`git fetch ${remote} ${branch}`, {
        cwd: repoPath,
        timeout: 10000
      });
      // Try to checkout just the lock file from remote (if it exists)
      try {
        await execAsync(`git checkout ${remote}/${branch} -- ${LOCK_FILENAME}`, { cwd: repoPath });
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

// Helper: get the GIT_ASKPASS env for a cowork repo's GitHub URL.
// Returns {} if no matching account configured (falls back to system creds).
async function getCoworkGitEnv(repoPath: string): Promise<Record<string, string>> {
  const coworkCfg = await loadCoworkConfig();
  const repo = coworkCfg.repositories.find(r => r.localPath === repoPath);
  if (!repo?.githubUrl) return {};
  return getGitCredentialEnv(repo.githubUrl);
}

ipcMain.handle('create-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);
  const gitEnv = await getCoworkGitEnv(repoPath);
  const mergedEnv = { ...process.env, ...gitEnv } as { [k: string]: string };
  const helperOverride = gitEnv.GIT_ASKPASS ? GIT_NO_HELPER : '';

  const lock: CoworkLock = {
    user: getUsername(),
    machine: getMachineName(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };

  try {
    // Write lock file
    await fs.promises.writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf-8');

    // Git add, commit, push (with the GH-account ASKPASS so the auth-bypass works)
    await execAsync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, env: mergedEnv });
    await execAsync(`git commit -m "🔒 Lock: ${lock.user}@${lock.machine} started working"`, { cwd: repoPath, env: mergedEnv });
    await execAsync(`git ${helperOverride} push ${remote} ${branch}`, { cwd: repoPath, env: mergedEnv });

    await addLogEntry('activity', `Cowork Lock erstellt: ${path.basename(repoPath)}`);
    return { success: true, lock };
  } catch (err) {
    // Clean up lock file if commit/push failed
    try {
      await fs.promises.unlink(lockPath);
      await execAsync('git checkout -- .', { cwd: repoPath });
    } catch {}
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('release-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);
  const gitEnv = await getCoworkGitEnv(repoPath);
  const mergedEnv = { ...process.env, ...gitEnv } as { [k: string]: string };
  const helperOverride = gitEnv.GIT_ASKPASS ? GIT_NO_HELPER : '';

  try {
    // Check if lock file exists
    await fs.promises.access(lockPath);

    // Remove lock file
    await fs.promises.unlink(lockPath);

    // Git add, commit, push. Wenn Branch divergiert ist, schlägt push fehl
    // und der User sieht den Fehler — kein automagisches Rebase mehr.
    await execAsync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, env: mergedEnv });
    await execAsync(`git commit -m "🔓 Unlock: ${getUsername()}@${getMachineName()} finished working"`, { cwd: repoPath, env: mergedEnv });
    await execAsync(`git ${helperOverride} push ${remote} ${branch}`, { cwd: repoPath, env: mergedEnv });

    await addLogEntry('activity', `Cowork Lock freigegeben: ${path.basename(repoPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('force-release-cowork-lock', async (_event, repoPath: string, remote: string, branch: string) => {
  const lockPath = path.join(repoPath, LOCK_FILENAME);
  const gitEnv = await getCoworkGitEnv(repoPath);
  const mergedEnv = { ...process.env, ...gitEnv } as { [k: string]: string };
  const helperOverride = gitEnv.GIT_ASKPASS ? GIT_NO_HELPER : '';

  try {
    // Sicherstellen, dass die Lock-Datei lokal existiert (sonst kein Commit nötig).
    // Falls nur Remote den Lock hat, holen wir uns die Datei via checkout.
    try {
      await fs.promises.access(lockPath);
    } catch {
      try {
        await execAsync(`git ${helperOverride} fetch ${remote} ${branch}`, { cwd: repoPath, timeout: 15000, env: mergedEnv });
        await execAsync(`git checkout ${remote}/${branch} -- ${LOCK_FILENAME}`, { cwd: repoPath, env: mergedEnv });
      } catch {
        // Kein Lock weit und breit — nichts zu tun
        return { success: true };
      }
    }

    await fs.promises.unlink(lockPath);
    await execAsync(`git add "${LOCK_FILENAME}"`, { cwd: repoPath, env: mergedEnv });
    await execAsync(`git commit -m "🔓 Force Unlock: ${getUsername()}@${getMachineName()} (override)"`, { cwd: repoPath, env: mergedEnv });
    // --force-with-lease: überschreibt fremde Locks, lässt aber andere Commits
    // auf dem Branch in Ruhe (Push fail wenn Branch-Tip sich änderte → User refresht).
    await execAsync(`git ${helperOverride} push --force-with-lease ${remote} ${branch}`, { cwd: repoPath, env: mergedEnv });

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
    await execAsync(`git clone "${normalizedUrl}" "${targetPath}"`, { encoding: 'utf-8' });

    await addLogEntry('activity', `Repository geklont: ${path.basename(targetPath)}`);
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message;
    await addLogEntry('error', `Clone fehlgeschlagen: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
});

// ── Cowork Repo Export / Import ──────────────────────────────────────────────
// Bundle contains the GitHub-URL + branch + ClaudeMC settings, so the recipient
// can one-click: pick target folder → ClaudeMC clones the repo and applies the
// settings. No Vault-Secrets are included.
interface CoworkExportV1 {
  claudemcCoworkExport: 'v1';
  exportedAt: string;
  exporterVersion: string;
  repo: {
    name: string;
    githubUrl: string;
    remote: string;
    branch: string;
    unleashed?: boolean;
    wikiProjectEnabled?: boolean;
    wikiVaultIndexEnabled?: boolean;
  };
  settings: { [name: string]: unknown };
}

ipcMain.handle('export-cowork-repository', async (_event, repoId: string): Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }> => {
  const config = await loadCoworkConfig();
  const repo = config.repositories.find(r => r.id === repoId);
  if (!repo) return { success: false, error: 'Cowork-Repo nicht gefunden' };

  const safeName = repo.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'cowork';
  const saveResult = await dialog.showSaveDialog(mainWindow!, {
    title: 'Cowork-Repo exportieren',
    defaultPath: `${safeName}-cowork.json`,
    filters: [{ name: 'ClaudeMC Cowork Export', extensions: ['json'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

  const readJson = async (filepath: string): Promise<unknown | null> => {
    try { return JSON.parse(await fs.promises.readFile(filepath, 'utf8')); } catch { return null; }
  };
  const settingsDir = path.join(os.homedir(), '.claude', 'projects', repo.id);

  const bundle: CoworkExportV1 = {
    claudemcCoworkExport: 'v1',
    exportedAt: new Date().toISOString(),
    exporterVersion: app.getVersion(),
    repo: {
      name: repo.name,
      githubUrl: repo.githubUrl,
      remote: repo.remote,
      branch: repo.branch,
      unleashed: repo.unleashed,
      wikiProjectEnabled: repo.wikiProjectEnabled,
      wikiVaultIndexEnabled: repo.wikiVaultIndexEnabled,
    },
    settings: {
      'settings.local.json': await readJson(path.join(settingsDir, 'settings.local.json')),
      'wiki-settings.json': await readJson(path.join(settingsDir, 'wiki-settings.json')),
    },
  };

  try {
    await fs.promises.writeFile(saveResult.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    await addLogEntry('activity', `Cowork-Repo exportiert: ${repo.name}`, saveResult.filePath);
    return { success: true, path: saveResult.filePath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('import-cowork-repository', async (): Promise<{ success: boolean; repository?: CoworkRepository; error?: string; canceled?: boolean }> => {
  const openResult = await dialog.showOpenDialog(mainWindow!, {
    title: 'Cowork-Export-Datei wählen',
    filters: [{ name: 'ClaudeMC Cowork Export', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (openResult.canceled || openResult.filePaths.length === 0) return { success: false, canceled: true };

  let bundle: CoworkExportV1;
  try {
    const raw = await fs.promises.readFile(openResult.filePaths[0], 'utf8');
    bundle = JSON.parse(raw) as CoworkExportV1;
  } catch {
    return { success: false, error: 'Datei konnte nicht gelesen werden' };
  }
  if (bundle.claudemcCoworkExport !== 'v1' || !bundle.repo?.githubUrl) {
    return { success: false, error: 'Unbekanntes oder beschädigtes Cowork-Export-Format' };
  }

  const targetResult = await dialog.showOpenDialog(mainWindow!, {
    title: `Übergeordneter Ordner für Clone von "${bundle.repo.name}" wählen`,
    buttonLabel: 'Hier hin klonen',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (targetResult.canceled || targetResult.filePaths.length === 0) return { success: false, canceled: true };
  const parentDir = targetResult.filePaths[0];
  const targetPath = path.join(parentDir, bundle.repo.name);

  const config = await loadCoworkConfig();
  if (config.repositories.some(r => r.localPath === targetPath)) {
    return { success: false, error: `Pfad ist bereits als Cowork-Repo registriert: ${targetPath}` };
  }

  // Clone (skips if target already has a .git directory, to allow re-importing)
  try {
    const hasGit = await fs.promises.access(path.join(targetPath, '.git')).then(() => true).catch(() => false);
    if (!hasGit) {
      await fs.promises.mkdir(parentDir, { recursive: true });
      const normalizedUrl = normalizeGitHubUrl(bundle.repo.githubUrl);
      await execAsync(`git clone "${normalizedUrl}" "${targetPath}"`, { encoding: 'utf-8', timeout: 300000 });
    }
  } catch (err) {
    return { success: false, error: `git clone fehlgeschlagen: ${(err as Error).message}` };
  }

  // Apply ClaudeMC settings
  const newRepoId = targetPath.replace(/\//g, '-');
  const settingsDir = path.join(os.homedir(), '.claude', 'projects', newRepoId);
  await fs.promises.mkdir(settingsDir, { recursive: true });
  for (const [name, value] of Object.entries(bundle.settings ?? {})) {
    if (value == null) continue;
    try {
      await fs.promises.writeFile(path.join(settingsDir, name), JSON.stringify(value, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Import] write cowork settings ${name} failed:`, err);
    }
  }

  let hasCLAUDEmd = false;
  try {
    await fs.promises.access(path.join(targetPath, 'CLAUDE.md'));
    hasCLAUDEmd = true;
  } catch { /* fine — repo might not ship one */ }

  const newRepo: CoworkRepository = {
    id: newRepoId,
    name: bundle.repo.name,
    localPath: targetPath,
    githubUrl: normalizeGitHubUrl(bundle.repo.githubUrl),
    remote: bundle.repo.remote,
    branch: bundle.repo.branch,
    hasCLAUDEmd,
    unleashed: bundle.repo.unleashed,
    wikiProjectEnabled: bundle.repo.wikiProjectEnabled,
    wikiVaultIndexEnabled: bundle.repo.wikiVaultIndexEnabled,
  };
  config.repositories.push(newRepo);
  await saveCoworkConfig(config);

  await addLogEntry('activity', `Cowork-Repo importiert: ${newRepo.name}`, targetPath);
  return { success: true, repository: newRepo };
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
async function sshExec(host: string, user: string, command: string, sshKeyPath?: string, timeoutMs: number = 30000): Promise<{ success: boolean; output: string; error?: string }> {
  const keyPath = findSshKey(sshKeyPath);
  if (!keyPath && sshKeyPath) {
    console.log(`[SSH] Warning: Specified key ${sshKeyPath} not found, trying without key`);
  }

  const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];
  if (keyPath) args.push('-i', keyPath);
  args.push(`${user}@${host}`, 'bash', '-s');
  const result = await sshSpawnWithStdin(args, command, timeoutMs);
  if (result.success) return result;

  const errorMsg = result.error || 'SSH command failed';

  if (errorMsg.includes('Permission denied') || errorMsg.includes('not accessible')) {
    if (!findSshKey(sshKeyPath)) {
      return {
        success: false,
        output: '',
        error: `SSH-Key nicht gefunden. Bitte erstelle einen SSH-Key:\n\nssh-keygen -t ed25519\n\noder kopiere einen bestehenden Key nach ~/.ssh/`,
      };
    }
  }

  // Filter out Docker deprecation warnings that aren't real errors
  let filteredError = errorMsg;
  if (filteredError.includes('DEPRECATED: The legacy builder is deprecated')) {
    const lines = filteredError.split('\n').filter(line =>
      !line.includes('DEPRECATED') &&
      !line.includes('BuildKit') &&
      line.trim() !== ''
    );
    if (lines.length === 0) {
      return { success: true, output: errorMsg, error: undefined };
    }
    filteredError = lines.join('\n');
  }
  return { success: false, output: result.output, error: filteredError };
}

// SCP helper
async function scpUpload(localPath: string, host: string, user: string, remotePath: string, sshKeyPath?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Find a valid SSH key
    const keyPath = findSshKey(sshKeyPath);
    const keyArg = keyPath ? `-i "${keyPath}"` : '';

    const scpCmd = `scp -o StrictHostKeyChecking=no ${keyArg} "${localPath}" ${user}@${host}:"${remotePath}"`;
    await execAsync(scpCmd, {
      encoding: 'utf-8',
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
  const pingResult = await sshExec(server.host, server.user, 'echo "ok"', server.sshKeyPath);
  if (!pingResult.success) {
    return {
      isOnline: false,
      containers: [],
      error: pingResult.error,
    };
  }

  // Get container status
  const containersResult = await sshExec(
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
    const { stdout: healthResult } = await execAsync(`curl -s -k --max-time 10 "${urls.production}${urls.health}" 2>/dev/null || echo '{}'`, {
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

  const result = await sshExec(
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
    const gitStatus = await isGitDirty(projectPath);
    if (gitStatus) {
      updateStep('git-check', 'error', 'Uncommitted changes vorhanden');
      return { success: false, duration: Date.now() - startTime, steps, error: 'Uncommitted changes vorhanden. Bitte erst committen.' };
    }
    updateStep('git-check', 'success');

    // Step 2: Server check
    updateStep('server-check', 'running');
    const serverCheck = await sshExec(server.host, server.user, 'echo "ok"', server.sshKeyPath);
    if (!serverCheck.success) {
      updateStep('server-check', 'error', serverCheck.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Server nicht erreichbar: ${serverCheck.error}` };
    }
    updateStep('server-check', 'success');

    // Step 3: Backup current image
    updateStep('backup', 'running');
    const backupResult = await sshExec(
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
      await execAsync(`COPYFILE_DISABLE=1 tar -czvf "${tarPath}" --exclude='.git' --exclude='bin' --exclude='obj' --exclude='node_modules' --exclude='*.tar.gz' --exclude='._*' .`, {
        cwd: projectPath,
      });
    } catch (err) {
      updateStep('transfer', 'error', 'Tar-Archiv erstellen fehlgeschlagen');
      return { success: false, duration: Date.now() - startTime, steps, error: `Tar erstellen fehlgeschlagen: ${(err as Error).message}` };
    }

    // Upload to server
    const uploadResult = await scpUpload(tarPath, server.host, server.user, `${server.directory}/deploy.tar.gz`, server.sshKeyPath);

    // Cleanup local tar
    try { await fs.promises.unlink(tarPath); } catch { /* ignore */ }

    if (!uploadResult.success) {
      updateStep('transfer', 'error', uploadResult.error);
      return { success: false, duration: Date.now() - startTime, steps, error: `Upload fehlgeschlagen: ${uploadResult.error}` };
    }
    updateStep('transfer', 'success');

    // Step 5: Build Docker image on server (5 min timeout for build)
    updateStep('build', 'running');
    const buildResult = await sshExec(
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
    const deployResult = await sshExec(
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
        const { stdout: httpCodeRaw } = await execAsync(`curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 "${healthUrl}" 2>/dev/null || echo "000"`, {
          encoding: 'utf-8',
        });
        const httpCode = httpCodeRaw.trim();

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
    const listResult = await sshExec(
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
    const rollbackResult = await sshExec(
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
  const result = await sshExec(host, user, 'echo "Connection successful"', sshKeyPath);
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

  // Add server context
  try {
    const allServers = loadServers();
    if (allServers.length > 0) {
      let serverCtx = '## Server-Infrastruktur\n\n';
      for (const srv of allServers) {
        serverCtx += `### ${srv.name}\n`;
        serverCtx += `- **Host:** ${srv.user}@${srv.host}${srv.port !== 22 ? `:${srv.port}` : ''}\n`;
        if (srv.purpose) serverCtx += `- **Zweck:** ${srv.purpose}\n`;
        try {
          const sysinfoPath = path.join(getServerSessionDir(srv.id), 'sysinfo.json');
          if (fs.existsSync(sysinfoPath)) {
            const si = JSON.parse(fs.readFileSync(sysinfoPath, 'utf8')) as ServerSysinfo;
            const uptimeDays = Math.floor(si.uptime / 86400);
            const uptimeHours = Math.floor((si.uptime % 86400) / 3600);
            serverCtx += `- **OS:** ${si.os}\n`;
            serverCtx += `- **CPU:** ${si.cpu}% | **RAM:** ${(si.mem.used / 1024).toFixed(1)}/${(si.mem.total / 1024).toFixed(1)} GB | **Disk:** ${si.disk.used}/${si.disk.total} GB\n`;
            serverCtx += `- **Uptime:** ${uptimeDays}d ${uptimeHours}h\n`;
          }
        } catch { /* ignore */ }
        // Server-session CLAUDE.md (memory about the server)
        try {
          const sessionClaudeMd = path.join(getServerSessionDir(srv.id), 'CLAUDE.md');
          if (fs.existsSync(sessionClaudeMd)) {
            const memory = fs.readFileSync(sessionClaudeMd, 'utf8').trim();
            if (memory) serverCtx += `- **Memory:**\n${memory}\n`;
          }
        } catch { /* ignore */ }
        serverCtx += '\n';
      }
      contexts['__servers__'] = serverCtx;
    }
  } catch { /* ignore */ }

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
      gitBranch = await getGitBranch(projectPath) || 'unbekannt';
    } catch { /* ignore */ }

    const content = `# ${projectName}\n\n*Synchronisiert: ${new Date().toLocaleString('de-DE')} | Branch: ${gitBranch}*\n\n---\n\n${claudeMdContent}`;
    const wikiPath = path.join(MC_WIKI_DIR, 'projects', `${projectId}.md`);
    await fs.promises.writeFile(wikiPath, content, 'utf-8');

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

    // Enrich agent environment so it can call `claudemc-task` to trigger
    // project tasks via the local CLI server.
    const agentEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: [
        path.join(os.homedir(), '.local', 'bin'),
        process.env.PATH,
        '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
      ].filter(Boolean).join(':'),
      CLAUDEMC_PROJECT_PATH: projectPath,
    };
    if (cliServerState) {
      agentEnv.CLAUDEMC_API = cliServerState.apiUrl;
      agentEnv.CLAUDEMC_TOKEN = cliServerState.token;
    }

    // Prepend task-skill hint if the project has tasks/*.sh — keeps the agent
    // aware that running them is one bash call away.
    let taskPrompt = task;
    try {
      const tasksDir = path.join(projectPath, 'tasks');
      const entries = await fs.promises.readdir(tasksDir).catch(() => [] as string[]);
      const scripts = entries.filter(e => e.endsWith('.sh'));
      if (scripts.length > 0 && cliServerState) {
        const lines: string[] = [];
        for (const s of scripts) {
          const content = await fs.promises.readFile(path.join(tasksDir, s), 'utf-8').catch(() => '');
          const meta = parseTaskFrontmatter(content);
          const name = s.replace(/\.sh$/, '');
          lines.push(`  - ${name}${meta.description ? `: ${meta.description}` : ''}`);
        }
        taskPrompt = `# Skill: Project Tasks

Dieses Projekt hat ausführbare Tasks (in tasks/*.sh), die du via Shell-Befehl auf einem Remote-VPS starten kannst.
Verwende dazu \`claudemc-task run <name>\` (ist im PATH). Output erscheint im RTaskMC-Tab mit Projekt-Badge.

Verfügbar:
${lines.join('\n')}

Listen aktualisieren: \`claudemc-task list\`

---

${task}`;
      }
    } catch { /* tasks dir not readable — fall through with original prompt */ }

    const child = spawn(claudeStatus.path, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', 'opus',
    ], {
      cwd: projectPath,
      env: agentEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    entry.process = child;
    child.stdin.write(taskPrompt, 'utf-8');
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

          // Capture session_id from any event that carries it (init system event has it)
          if (!entry.sessionId && typeof json.session_id === 'string') {
            entry.sessionId = json.session_id;
            mainWindow?.webContents.send('agent-list-updated');
          }

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

ipcMain.handle('reply-to-agent', async (_event, agentId: string, reply: string) => {
  try {
    const entry = agentMap.get(agentId);
    if (!entry) return { success: false, error: 'Agent nicht gefunden.' };
    if (!entry.sessionId) return { success: false, error: 'Keine Session-ID — Agent kann nicht fortgesetzt werden.' };
    if (entry.process) return { success: false, error: 'Agent läuft noch.' };

    const claudeStatus = checkClaudeCode();
    if (!claudeStatus.installed || !claudeStatus.path) {
      return { success: false, error: 'Claude CLI nicht installiert oder nicht im PATH.' };
    }

    const autonomyHint =
      'Arbeite ab hier vollständig autonom — keine weiteren Rückfragen. ' +
      'Triff sinnvolle Annahmen, dokumentiere sie kurz im Endbericht und liefere ein vollständiges Ergebnis.\n\n' +
      'Meine Antwort auf deine Klärungsfrage:\n';
    const fullReply = autonomyHint + reply;

    entry.state = 'running';
    entry.error = undefined;
    entry.finishedAt = undefined;
    entry.output += '\n\n--- Antwort ---\n' + reply + '\n\n--- Fortsetzung ---\n';
    mainWindow?.webContents.send('agent-chunk', { agentId, text: '\n\n--- Antwort ---\n' + reply + '\n\n--- Fortsetzung ---\n' });
    mainWindow?.webContents.send('agent-list-updated');

    const child = spawn(claudeStatus.path, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', 'opus',
      '--resume', entry.sessionId,
    ], {
      cwd: entry.projectPath,
      env: {
        ...process.env,
        PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    entry.process = child;
    child.stdin.write(fullReply, 'utf-8');
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

          // Resume may return a new session_id (forked session)
          if (typeof json.session_id === 'string' && json.session_id !== entry.sessionId) {
            entry.sessionId = json.session_id;
          }

          if (
            json.type === 'stream_event' &&
            json.event?.type === 'content_block_delta' &&
            json.event?.delta?.type === 'text_delta' &&
            json.event?.delta?.text
          ) {
            const text = json.event.delta.text;
            if (entry.output.length < 100_000) {
              entry.output += text;
            }
            mainWindow?.webContents.send('agent-chunk', { agentId, text });
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      console.log(`[Agent ${agentId} reply stderr]`, data.toString().trim());
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

ipcMain.handle('save-agent-feedback', async (
  _event,
  _agentId: string,
  projectPath: string,
  task: string,
  output: string,
  feedback: string
): Promise<{ success: boolean; path: string; error?: string }> => {
  try {
    const tasksDir = path.join(projectPath, 'tasks');
    const targetPath = fs.existsSync(tasksDir)
      ? path.join(tasksDir, 'agent-iterations.md')
      : path.join(projectPath, 'CLAUDE.md');

    const now = new Date().toISOString();
    const outputSnippet = output.length > 2000
      ? output.slice(0, 2000) + '\n...(gekürzt)'
      : output;

    const entry = [
      `\n## Agent Iteration — ${now}`,
      `\n**Task:** ${task}`,
      `\n**Feedback:** ${feedback}`,
      `\n**Output (Auszug):**`,
      '```',
      outputSnippet,
      '```',
      '\n---\n',
    ].join('\n');

    await fs.promises.appendFile(targetPath, entry, 'utf8');
    return { success: true, path: targetPath };
  } catch (err) {
    return { success: false, path: '', error: (err as Error).message };
  }
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

/** Resolve IMAP password: vault first, fallback to plaintext (legacy) */
function resolveAccountPassword(account: import('../shared/types').MailAccount): string {
  if (account.authType === 'oauth2') return '';
  return vaultGet(`mail:${account.id}:password`) ?? account.password ?? '';
}

ipcMain.handle('get-mail-accounts', async (): Promise<import('../shared/types').MailAccount[]> => {
  // Return accounts with password masked — UI only needs to know IF set
  return loadMailAccounts().map(a => ({
    ...a,
    password: a.password === VAULT_SENTINEL ? VAULT_SENTINEL : (a.password ? VAULT_SENTINEL : ''),
  }));
});

ipcMain.handle('save-mail-account', async (_event, account: import('../shared/types').MailAccount): Promise<{ success: boolean; error?: string }> => {
  try {
    const accounts = loadMailAccounts();
    const idx = accounts.findIndex(a => a.id === account.id);
    // Move plaintext password to vault, store sentinel in JSON
    const toSave = { ...account };
    if (toSave.password && toSave.password !== VAULT_SENTINEL) {
      vaultSet(`mail:${toSave.id}:password`, toSave.password);
      toSave.password = VAULT_SENTINEL;
    } else if (idx >= 0 && (!toSave.password || toSave.password === VAULT_SENTINEL)) {
      // Password unchanged (UI sent sentinel back) — keep existing vault entry
      toSave.password = VAULT_SENTINEL;
    }
    if (idx >= 0) { accounts[idx] = toSave; } else { accounts.push(toSave); }
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
    vaultDeletePrefix(`mail:${accountId}:`);
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
  // 1. Try vault first
  const vaultKey = `mail:${accountId}:oauth2`;
  const vaultData = vaultGet(vaultKey);
  if (vaultData) {
    try { return JSON.parse(vaultData); } catch { /* fall through */ }
  }
  // 2. Fallback: legacy JSON file → migrate to vault
  try {
    const p = getOAuth2TokenPath(accountId);
    if (!fs.existsSync(p)) return null;
    const tokens = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Migrate to vault, delete plaintext file
    try {
      vaultSet(vaultKey, JSON.stringify(tokens));
      fs.unlinkSync(p);
      console.log(`[vault] Migrated OAuth2 tokens for ${accountId}`);
    } catch { /* keep file if vault fails */ }
    return tokens;
  } catch { return null; }
}

function saveOAuth2Tokens(accountId: string, tokens: import('../shared/types').OAuth2Tokens): void {
  vaultSet(`mail:${accountId}:oauth2`, JSON.stringify(tokens));
  // Clean up legacy file if it still exists
  try {
    const p = getOAuth2TokenPath(accountId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
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
    vaultDelete(`mail:${accountId}:oauth2`);
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
              const p = resolveAccountPassword(account).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
              const p = resolveAccountPassword(account).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

// ─── Ollama: collect full text via streaming (reuses proven ollamaStream) ────
function ollamaCollect(urlStr: string, model: string, messages: object[], options?: object, timeoutMs = 30000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ollamaCollect timeout after ${timeoutMs}ms`)), timeoutMs);
    let text = '';
    ollamaStream(
      urlStr,
      { model, messages, stream: true, ...(options ? { options } : {}) },
      (chunk) => { text += chunk; },
      () => { clearTimeout(timer); resolve(text); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ─── Ollama: classify mail batch ──────────────────────────────────────────────
ipcMain.handle('ollama-classify-mail', async (event, ollamaUrl: string, model: string, emails: Array<{ uid: number; from: string; subject: string }>) => {
  const CATEGORIES = ['URGENT', 'ACTION', 'RECHNUNG', 'EINKAUF', 'FYI', 'NOISE'] as const;
  const SYSTEM = [
    'Classify emails into exactly one category. Reply with ONLY the category word.',
    '',
    'URGENT   = needs immediate reply or action TODAY (deadline today, emergency, critical issue)',
    'ACTION   = someone asks you to do something / task for you (bitte, please, könnten Sie, Aufgabe, erledigen, prüfen, Anfrage)',
    'RECHNUNG = actual invoice, bill, credit note, payment reminder, dunning (Rechnung, Gutschrift, Mahnung, Zahlungserinnerung, Kontoauszug). NOT order confirmations or shipping notifications — those belong to EINKAUF.',
    'EINKAUF  = order confirmations, shipping/dispatch notifications, delivery tracking, package arrival, return confirmations (Auftragsbestätigung, Bestellbestätigung, Versandbestätigung, Versandmitteilung, Lieferung, Sendungsverfolgung, Tracking, Retoure)',
    'FYI      = informational only, no action needed (status update, report, confirmation, newsletter from known sender)',
    'NOISE    = marketing, spam, automated system alert, mass newsletter',
    '',
    'Examples:',
    'Subject: Rechnung 2024-001 → RECHNUNG',
    'Subject: Zahlungserinnerung Rechnung 12345 → RECHNUNG',
    'Subject: Ihre Bestellung wurde versendet → EINKAUF',
    'Subject: Auftragsbestätigung #4711 Amazon → EINKAUF',
    'Subject: Ihr DHL-Paket ist unterwegs → EINKAUF',
    'Subject: Retoure erhalten → EINKAUF',
    'Subject: Bitte Angebot prüfen → ACTION',
    'Subject: Neue Zertifizierung in der Signatur, ISO → ACTION',
    'Subject: RE: Meeting Protokoll → FYI',
    'Subject: 20% Rabatt nur heute → NOISE',
    '',
    'Reply with ONLY one word: URGENT, ACTION, RECHNUNG, EINKAUF, FYI, or NOISE.',
  ].join('\n');
  const results: { uid: number; category: string }[] = [];
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    let category = 'FYI';
    try {
      const content = (await ollamaCollect(ollamaUrl, model, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}` },
      ], { temperature: 0.1 })).trim();
      const firstWord = content.split(/[\s\n.,;:!?]+/)[0].toUpperCase();
      category = (CATEGORIES as readonly string[]).find(c => c === firstWord)
        ?? (CATEGORIES as readonly string[]).find(c => content.toUpperCase().includes(c))
        ?? 'FYI';
      console.log(`[classify] uid=${email.uid} subj="${email.subject.slice(0,35)}" raw="${content.slice(0,30)}" → ${category}`);
    } catch (err) {
      console.error(`[classify] uid=${email.uid} error:`, (err as Error).message);
    }
    results.push({ uid: email.uid, category });
    try { event.sender.send('classify-mail-progress', { done: i + 1, total: emails.length, uid: email.uid, category }); } catch { /* renderer gone */ }
  }
  return results;
});

ipcMain.handle('kill-ollama', async (): Promise<{ success: boolean; error?: string }> => {
  try {
    await execAsync('pkill -x ollama').catch(() => execAsync('pkill -f "ollama serve"').catch(() => {}));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Ollama: ensure running (auto-start if needed, poll until reachable) ─────
async function ollamaIsReachable(ollamaUrl: string): Promise<boolean> {
  try {
    const u = new URL('/api/tags', ollamaUrl);
    const mod = u.protocol === 'https:' ? await import('https') : await import('http');
    return await new Promise<boolean>((resolve) => {
      const req = mod.request({
        host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname, method: 'GET', timeout: 2000,
      }, (res) => { res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch { return false; }
}

ipcMain.handle('ollama-ensure-running', async (_event, ollamaUrl: string): Promise<{ success: boolean; started: boolean; error?: string }> => {
  if (await ollamaIsReachable(ollamaUrl)) return { success: true, started: false };

  // Spawn `ollama serve` detached so it survives this handler's lifetime
  try {
    const env = { ...process.env, PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') };
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', env });
    child.unref();
    child.on('error', (err) => console.error('[ollama-ensure-running] spawn error:', err.message));
  } catch (err) {
    return { success: false, started: false, error: `Konnte 'ollama serve' nicht starten: ${(err as Error).message}` };
  }

  // Poll up to 10s
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await ollamaIsReachable(ollamaUrl)) return { success: true, started: true };
    await new Promise(r => setTimeout(r, 500));
  }
  return { success: false, started: true, error: 'Ollama startete nicht innerhalb von 10 Sekunden' };
});

// ─── Claude Inkognito (CLI Subprozess, --no-session-persistence) ─────────────
// Streamt Text-Output via onChunk-Callback, resolved mit gesammeltem Text bei close.
function runClaudeInkognito(opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;           // 'haiku' | 'sonnet' | 'opus' (default: 'haiku')
  onChunk?: (text: string) => void;
}): Promise<{ success: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    const claudeStatus = checkClaudeCode();
    if (!claudeStatus.installed || !claudeStatus.path) {
      return resolve({ success: false, text: '', error: 'Claude CLI nicht installiert oder nicht im PATH.' });
    }
    const model = opts.model || 'haiku';
    const prompt = `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`;

    const child = spawn(claudeStatus.path, [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--verbose',
      '--model', model,
    ], {
      env: {
        ...process.env,
        PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();

    let collected = '';
    let buffer = '';
    let stderrBuf = '';

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
            const t = json.event.delta.text as string;
            collected += t;
            if (opts.onChunk) { try { opts.onChunk(t); } catch { /* ignore */ } }
          }
        } catch { /* non-JSON line, skip */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => { stderrBuf += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) resolve({ success: true, text: collected });
      else resolve({ success: false, text: collected, error: stderrBuf.trim().slice(0, 500) || `Claude CLI exit code ${code}` });
    });

    child.on('error', (err) => resolve({ success: false, text: collected, error: err.message }));
  });
}

// ─── Claude: batch classify mails (1 call, JSON array out) ───────────────────
ipcMain.handle('claude-classify-mail-batch', async (event, emails: Array<{ uid: number; from: string; subject: string }>, model?: string): Promise<{ uid: number; category: string }[]> => {
  const CATEGORIES = ['URGENT', 'ACTION', 'RECHNUNG', 'EINKAUF', 'FYI', 'NOISE'] as const;
  const SYSTEM = [
    'You are an email classifier. Classify each email into exactly one category.',
    '',
    'Categories:',
    'URGENT   = needs immediate reply or action TODAY',
    'ACTION   = task for you (please do X, prüfen, Anfrage, bitte)',
    'RECHNUNG = actual invoice, bill, credit note, payment reminder (Rechnung, Gutschrift, Mahnung, Zahlungserinnerung). NOT order confirmations.',
    'EINKAUF  = order confirmations, shipping notifications, delivery tracking, returns (Auftragsbestätigung, Versand, DHL-Paket, Retoure)',
    'FYI      = informational only (status updates, reports, confirmations)',
    'NOISE    = marketing, spam, mass newsletters',
    '',
    'Output: ONLY a JSON array, no prose, no markdown fences.',
    'Format: [{"uid": <number>, "category": "<CATEGORY>"}, ...]',
    'Use the exact uid from the input. Use uppercase category names.',
  ].join('\n');

  const CHUNK_SIZE = 50;
  const results: { uid: number; category: string }[] = [];

  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    const chunk = emails.slice(i, i + CHUNK_SIZE);
    const lines = chunk.map(e => `uid=${e.uid} | from=${e.from.replace(/\s+/g, ' ').slice(0, 100)} | subject=${e.subject.replace(/\s+/g, ' ').slice(0, 150)}`);
    const userMsg = `Classify these ${chunk.length} emails:\n\n${lines.join('\n')}`;

    const res = await runClaudeInkognito({ systemPrompt: SYSTEM, userMessage: userMsg, model });
    // Try to extract JSON array from output
    let parsed: { uid: number; category: string }[] = [];
    if (res.success && res.text) {
      const jsonMatch = res.text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const arr = JSON.parse(jsonMatch[0]) as Array<{ uid: number | string; category: string }>;
          parsed = arr.map(item => {
            const uid = typeof item.uid === 'string' ? parseInt(item.uid, 10) : item.uid;
            const cat = String(item.category).toUpperCase().trim();
            const safe = (CATEGORIES as readonly string[]).includes(cat) ? cat : 'FYI';
            return { uid, category: safe };
          }).filter(p => !isNaN(p.uid));
        } catch (err) {
          console.error('[claude-classify] JSON parse error:', (err as Error).message, res.text.slice(0, 200));
        }
      } else {
        console.error('[claude-classify] no JSON array in output:', res.text.slice(0, 200));
      }
    } else {
      console.error('[claude-classify] call failed:', res.error);
    }

    // Fill missing UIDs with FYI fallback
    for (const e of chunk) {
      const found = parsed.find(p => p.uid === e.uid);
      const final = found ?? { uid: e.uid, category: 'FYI' };
      results.push(final);
      try { event.sender.send('classify-mail-progress', { done: results.length, total: emails.length, uid: final.uid, category: final.category }); } catch { /* renderer gone */ }
    }
  }

  return results;
});

// ─── Claude: stream analysis (summary, reply, etc.) → 'claude-chunk' event ───
ipcMain.handle('claude-analyze-mail', async (event, systemPrompt: string, userMessage: string, model?: string): Promise<{ success: boolean; error?: string }> => {
  const res = await runClaudeInkognito({
    systemPrompt, userMessage, model,
    onChunk: (text) => { try { event.sender.send('claude-chunk', { text }); } catch { /* renderer gone */ } },
  });
  try { event.sender.send('claude-chunk', { done: true, error: res.error }); } catch { /* renderer gone */ }
  return { success: res.success, error: res.error };
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

// ─── Server Credential Manager (v1.1.24) ─────────────────────────────────────

const SERVERS_PATH = path.join(os.homedir(), '.claude', 'servers.json');

type ServerCredential = import('../shared/types').ServerCredential;

function loadServers(): ServerCredential[] {
  try {
    const raw = fs.readFileSync(SERVERS_PATH, 'utf8');
    return JSON.parse(raw) as ServerCredential[];
  } catch {
    return [];
  }
}

function saveServers(servers: ServerCredential[]): void {
  const dir = path.dirname(SERVERS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SERVERS_PATH, JSON.stringify(servers, null, 2), 'utf8');
}

function findSshpass(): string | null {
  const candidates = ['/usr/bin/sshpass', '/usr/local/bin/sshpass', '/opt/homebrew/bin/sshpass'];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// Run an SSH command using stdin to deliver the script. This avoids the
// quoting nightmare of putting a multi-line shell script with embedded
// quotes/backslashes on the command line. Remote runs `bash -s`, which reads
// the command verbatim from stdin.
function sshSpawnWithStdin(
  args: string[],
  command: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  bin = 'ssh',
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result: { success: boolean; output: string; error?: string }) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ success: false, output: stdout, error: stderr || `Timeout nach ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ success: false, output: stdout, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ success: true, output: stdout.trim() });
      else finish({ success: false, output: stdout, error: stderr.trim() || stdout.trim() || `Exit ${code}` });
    });
    try {
      child.stdin.end(command);
    } catch (err) {
      clearTimeout(timer);
      finish({ success: false, output: '', error: (err as Error).message });
    }
  });
}

async function sshExecWithCreds(server: ServerCredential, command: string, timeoutMs = 30000): Promise<{ success: boolean; output: string; error?: string }> {
  const port = server.port || 22;
  const baseArgs = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];
  if (port !== 22) baseArgs.push('-p', String(port));

  if (server.authType === 'password') {
    const password = vaultGet(`server:${server.id}:password`);
    if (!password) return { success: false, output: '', error: 'Kein Passwort im Vault gefunden' };

    // Prefer sshpass if available, otherwise fall back to SSH_ASKPASS (no external tool needed)
    const sshpassBin = findSshpass();
    if (sshpassBin) {
      const args = ['-e', 'ssh', ...baseArgs, `${server.user}@${server.host}`, 'bash', '-s'];
      return sshSpawnWithStdin(args, command, timeoutMs, { SSHPASS: password }, sshpassBin);
    }

    // Fallback: SSH_ASKPASS script – works without sshpass
    const tmpPwScript = path.join(os.tmpdir(), `sshpw-${server.id}-${Date.now()}.sh`);
    fs.writeFileSync(tmpPwScript, `#!/bin/sh\necho '${password.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
    const args = [...baseArgs, '-o', 'PasswordAuthentication=yes', '-o', 'PubkeyAuthentication=no', `${server.user}@${server.host}`, 'bash', '-s'];
    const result = await sshSpawnWithStdin(args, command, timeoutMs, { SSH_ASKPASS: tmpPwScript, DISPLAY: ':0', SSH_ASKPASS_REQUIRE: 'force' });
    try { fs.unlinkSync(tmpPwScript); } catch { /* ignore */ }
    return result;
  }

  // key / both: use ssh -i keyPath
  const keyPath = server.sshKeyPath?.replace('~', os.homedir());
  const keyArgs = keyPath && fs.existsSync(keyPath) ? ['-i', keyPath] : [];

  if (server.hasPassphrase && keyPath) {
    const passphrase = vaultGet(`server:${server.id}:sshPassphrase`);
    if (passphrase) {
      const tmpScript = path.join(os.tmpdir(), `sshaskpass-${server.id}.sh`);
      fs.writeFileSync(tmpScript, `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
      const args = [...baseArgs, ...keyArgs, `${server.user}@${server.host}`, 'bash', '-s'];
      const result = await sshSpawnWithStdin(args, command, timeoutMs, { SSH_ASKPASS: tmpScript, DISPLAY: process.env.DISPLAY || ':0', SSH_ASKPASS_REQUIRE: 'force' });
      try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
      return result;
    }
  }

  // Simple key auth or no passphrase
  const args = [...baseArgs, ...keyArgs, `${server.user}@${server.host}`, 'bash', '-s'];
  return sshSpawnWithStdin(args, command, timeoutMs);
}

ipcMain.handle('get-servers', async (_event, projectId?: string): Promise<ServerCredential[]> => {
  const servers = loadServers();
  if (!projectId) return servers;
  return servers.filter(s => s.projectIds.length === 0 || s.projectIds.includes(projectId));
});

ipcMain.handle('save-server', async (_event, serverData: Partial<ServerCredential>, secrets: { sshPassphrase?: string; password?: string; apiToken?: string }): Promise<ServerCredential> => {
  const servers = loadServers();
  const now = new Date().toISOString();
  let server: ServerCredential;
  let isNew = false;

  if (serverData.id) {
    const idx = servers.findIndex(s => s.id === serverData.id);
    if (idx === -1) throw new Error('Server nicht gefunden');
    server = { ...servers[idx], ...serverData, updatedAt: now };
    servers[idx] = server;
  } else {
    isNew = true;
    server = {
      id: crypto.randomUUID(),
      name: serverData.name || 'Neuer Server',
      host: serverData.host || '',
      port: serverData.port || 22,
      user: serverData.user || 'root',
      authType: serverData.authType || 'key',
      sshKeyPath: serverData.sshKeyPath,
      hasPassphrase: false,
      hasPassword: false,
      hasApiToken: false,
      projectIds: serverData.projectIds || [],
      notes: serverData.notes,
      createdAt: now,
      updatedAt: now,
    };
    servers.push(server);
  }

  // Store secrets in vault (empty string = delete)
  if (secrets.sshPassphrase !== undefined) {
    if (secrets.sshPassphrase) { vaultSet(`server:${server.id}:sshPassphrase`, secrets.sshPassphrase); server.hasPassphrase = true; }
    else { vaultDelete(`server:${server.id}:sshPassphrase`); server.hasPassphrase = false; }
  }
  if (secrets.password !== undefined) {
    if (secrets.password) { vaultSet(`server:${server.id}:password`, secrets.password); server.hasPassword = true; }
    else { vaultDelete(`server:${server.id}:password`); server.hasPassword = false; }
  }
  if (secrets.apiToken !== undefined) {
    if (secrets.apiToken) { vaultSet(`server:${server.id}:apiToken`, secrets.apiToken); server.hasApiToken = true; }
    else { vaultDelete(`server:${server.id}:apiToken`); server.hasApiToken = false; }
  }

  // Reflect current vault state if secret not explicitly provided
  if (secrets.sshPassphrase === undefined) server.hasPassphrase = vaultHas(`server:${server.id}:sshPassphrase`);
  if (secrets.password === undefined) server.hasPassword = vaultHas(`server:${server.id}:password`);
  if (secrets.apiToken === undefined) server.hasApiToken = vaultHas(`server:${server.id}:apiToken`);

  // Update in-place for edits (index may have changed)
  if (!isNew) {
    const idx = servers.findIndex(s => s.id === server.id);
    if (idx !== -1) servers[idx] = server;
  } else {
    servers[servers.length - 1] = server;
  }

  saveServers(servers);
  return server;
});

ipcMain.handle('remove-server', async (_event, serverId: string): Promise<void> => {
  const servers = loadServers().filter(s => s.id !== serverId);
  saveServers(servers);
  vaultDeletePrefix(`server:${serverId}:`);
});

ipcMain.handle('test-server-connection', async (_event, serverId: string): Promise<{ success: boolean; output: string; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { success: false, output: '', error: 'Server nicht gefunden' };
  return sshExecWithCreds(server, 'echo "ClaudeMC connection test OK"', 15000);
});

ipcMain.handle('ssh-open-terminal', async (_event, serverId: string): Promise<{ tabId: string; serverName: string; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { tabId: '', serverName: '', error: 'Server nicht gefunden' };

  // Auto-setup SSH key on first connect (best-effort, don't block on failure)
  setupSshKeyOnServer(server).catch(() => { /* ignore */ });

  const tabId = `ssh-${serverId}-${Date.now()}`;
  const port = server.port || 22;
  const portArgs = port !== 22 ? ['-p', String(port)] : [];
  const baseArgs = ['-o', 'StrictHostKeyChecking=no', ...portArgs];

  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  if (server.authType === 'password') {
    const password = vaultGet(`server:${server.id}:password`);
    const sshpassBin = findSshpass();
    if (password && sshpassBin) {
      spawnCmd = sshpassBin;
      spawnArgs = ['-e', 'ssh', ...baseArgs, `${server.user}@${server.host}`];
      spawnEnv.SSHPASS = password;
    } else {
      // Fall back: interactive password prompt in terminal
      spawnCmd = 'ssh';
      spawnArgs = [...baseArgs, `${server.user}@${server.host}`];
    }
  } else {
    const keyPath = server.sshKeyPath?.replace('~', os.homedir());
    const keyArgs = keyPath && fs.existsSync(keyPath) ? ['-i', keyPath] : [];
    spawnCmd = 'ssh';
    spawnArgs = [...baseArgs, ...keyArgs, `${server.user}@${server.host}`];

    if (server.hasPassphrase && keyPath) {
      const passphrase = vaultGet(`server:${server.id}:sshPassphrase`);
      if (passphrase) {
        const tmpScript = path.join(os.tmpdir(), `sshaskpass-${server.id}.sh`);
        fs.writeFileSync(tmpScript, `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
        spawnEnv.SSH_ASKPASS = tmpScript;
        spawnEnv.DISPLAY = spawnEnv.DISPLAY || ':0';
        spawnEnv.SSH_ASKPASS_REQUIRE = 'force';
        setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch { /* ignore */ } }, 60000);
      }
    }
  }

  // Add common paths to env PATH so ssh/sshpass can be found
  spawnEnv.PATH = [spawnEnv.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');

  const ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: spawnEnv,
  });

  ptyProcesses.set(tabId, ptyProcess);

  ptyProcess.onData((data) => {
    const existing = ptyDataBuffers.get(tabId);
    ptyDataBuffers.set(tabId, existing ? existing + data : data);
    if (!ptyDataTimers.has(tabId)) {
      ptyDataTimers.set(tabId, setTimeout(() => {
        ptyDataTimers.delete(tabId);
        const batch = ptyDataBuffers.get(tabId);
        if (batch) {
          ptyDataBuffers.delete(tabId);
          mainWindow?.webContents.send('pty-data', tabId, batch);
        }
      }, 8));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const exitTimer = ptyDataTimers.get(tabId);
    if (exitTimer !== undefined) { clearTimeout(exitTimer); ptyDataTimers.delete(tabId); }
    const remaining = ptyDataBuffers.get(tabId);
    if (remaining) {
      ptyDataBuffers.delete(tabId);
      mainWindow?.webContents.send('pty-data', tabId, remaining);
    }
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
  });

  return { tabId, serverName: `${server.user}@${server.host}` };
});

ipcMain.handle('ssh-claude-terminal', async (_event, serverId: string): Promise<{ tabId: string; serverName: string; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { tabId: '', serverName: '', error: 'Server nicht gefunden' };

  const tabId = `ssh-claude-${serverId}-${Date.now()}`;
  const port = server.port || 22;
  const portArgs = port !== 22 ? ['-p', String(port)] : [];
  const baseArgs = ['-o', 'StrictHostKeyChecking=no', '-t', ...portArgs];

  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  if (server.authType === 'password') {
    const password = vaultGet(`server:${server.id}:password`);
    const sshpassBin = findSshpass();
    if (password && sshpassBin) {
      spawnCmd = sshpassBin;
      spawnArgs = ['-e', 'ssh', ...baseArgs, `${server.user}@${server.host}`, 'bash', '-l', '-c', 'which claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code; bash -l -c claude'];
      spawnEnv.SSHPASS = password;
    } else {
      spawnCmd = 'ssh';
      spawnArgs = [...baseArgs, `${server.user}@${server.host}`, 'bash', '-l', '-c', 'which claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code; bash -l -c claude'];
    }
  } else {
    const keyPath = server.sshKeyPath?.replace('~', os.homedir());
    const keyArgs = keyPath && fs.existsSync(keyPath) ? ['-i', keyPath] : [];
    spawnCmd = 'ssh';
    spawnArgs = [...baseArgs, ...keyArgs, `${server.user}@${server.host}`, 'bash', '-l', '-c', 'which claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code; bash -l -c claude'];

    if (server.hasPassphrase && keyPath) {
      const passphrase = vaultGet(`server:${server.id}:sshPassphrase`);
      if (passphrase) {
        const tmpScript = path.join(os.tmpdir(), `sshaskpass-${server.id}.sh`);
        fs.writeFileSync(tmpScript, `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
        spawnEnv.SSH_ASKPASS = tmpScript;
        spawnEnv.DISPLAY = spawnEnv.DISPLAY || ':0';
        spawnEnv.SSH_ASKPASS_REQUIRE = 'force';
        setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch { /* ignore */ } }, 60000);
      }
    }
  }

  spawnEnv.PATH = [spawnEnv.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');

  const ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: spawnEnv,
  });

  ptyProcesses.set(tabId, ptyProcess);

  ptyProcess.onData((data) => {
    const existing = ptyDataBuffers.get(tabId);
    ptyDataBuffers.set(tabId, existing ? existing + data : data);
    if (!ptyDataTimers.has(tabId)) {
      ptyDataTimers.set(tabId, setTimeout(() => {
        ptyDataTimers.delete(tabId);
        const batch = ptyDataBuffers.get(tabId);
        if (batch) {
          ptyDataBuffers.delete(tabId);
          mainWindow?.webContents.send('pty-data', tabId, batch);
        }
      }, 8));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const exitTimer = ptyDataTimers.get(tabId);
    if (exitTimer !== undefined) { clearTimeout(exitTimer); ptyDataTimers.delete(tabId); }
    const remaining = ptyDataBuffers.get(tabId);
    if (remaining) {
      ptyDataBuffers.delete(tabId);
      mainWindow?.webContents.send('pty-data', tabId, remaining);
    }
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
  });

  return { tabId, serverName: `${server.user}@${server.host}` };
});

ipcMain.handle('claude-server-session', async (_event, serverId: string, unleashed: boolean = false): Promise<{ tabId: string; serverName: string; sessionDir: string; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { tabId: '', serverName: '', sessionDir: '', error: 'Server nicht gefunden' };

  // Auto-setup SSH key on first connect (best-effort, don't block on failure)
  setupSshKeyOnServer(server).catch(() => { /* ignore */ });

  const sessionDir = path.join(os.homedir(), '.claude', 'server-sessions', serverId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const port = server.port || 22;
  const portFlag = port !== 22 ? ` -p ${port}` : '';
  const keyPath = server.sshKeyPath?.replace('~', os.homedir());
  const keyFlag = keyPath && fs.existsSync(keyPath) ? ` -i ${keyPath}` : '';
  const sshCmd = `ssh${portFlag}${keyFlag} ${server.user}@${server.host}`;

  // server-info.md: immer aktuell überschreiben
  const serverInfoMd = `# Server: ${server.name}

## Verbindung
- **Host:** ${server.host}
- **Port:** ${port}
- **User:** ${server.user}
${keyPath ? `- **SSH Key:** ${keyPath}` : ''}
${server.notes ? `- **Notizen:** ${server.notes}` : ''}

## SSH-Befehl
\`\`\`bash
${sshCmd}
\`\`\`

## Nicht-interaktiver SSH-Befehl (für Bash-Tool)
\`\`\`bash
ssh -o StrictHostKeyChecking=no${portFlag}${keyFlag} ${server.user}@${server.host} '<befehl>'
\`\`\`
`;
  fs.writeFileSync(path.join(sessionDir, 'server-info.md'), serverInfoMd);

  // CLAUDE.md: nur anlegen wenn noch nicht vorhanden (Memory erhalten)
  const claudeMdPath = path.join(sessionDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const claudeMd = `# Server-Session: ${server.name}

Verbindungsdetails siehe server-info.md.

## Was ich über diesen Server weiß

<!-- Hier sammle ich Wissen über den Server -->

## Installierte Dienste

## Wichtige Pfade

## Offene Aufgaben
`;
    fs.writeFileSync(claudeMdPath, claudeMd);
  }

  const tabId = `claude-server-${serverId}-${Date.now()}`;
  const shellPath = process.env.SHELL || '/bin/zsh';

  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: sessionDir,
    env: {
      ...(process.env as Record<string, string>),
      PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
    },
  });

  ptyProcesses.set(tabId, ptyProcess);

  ptyProcess.onData((data) => {
    const existing = ptyDataBuffers.get(tabId);
    ptyDataBuffers.set(tabId, existing ? existing + data : data);
    if (!ptyDataTimers.has(tabId)) {
      ptyDataTimers.set(tabId, setTimeout(() => {
        ptyDataTimers.delete(tabId);
        const batch = ptyDataBuffers.get(tabId);
        if (batch) {
          ptyDataBuffers.delete(tabId);
          mainWindow?.webContents.send('pty-data', tabId, batch);
        }
      }, 8));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const exitTimer = ptyDataTimers.get(tabId);
    if (exitTimer !== undefined) { clearTimeout(exitTimer); ptyDataTimers.delete(tabId); }
    const remaining = ptyDataBuffers.get(tabId);
    if (remaining) {
      ptyDataBuffers.delete(tabId);
      mainWindow?.webContents.send('pty-data', tabId, remaining);
    }
    mainWindow?.webContents.send('pty-exit', tabId, exitCode);
    ptyProcesses.delete(tabId);
  });

  // Claude lokal starten — liest CLAUDE.md + server-info.md automatisch
  setTimeout(() => {
    const initPrompt = `Lies CLAUDE.md und server-info.md. Du verwaltest den Server ${server.name} (${server.user}@${server.host}) per SSH. Was soll ich tun?`;
    const claudeCmd = unleashed
      ? `claude --dangerously-skip-permissions '${initPrompt}'\r`
      : `claude '${initPrompt}'\r`;
    ptyProcess.write(claudeCmd);
  }, 500);

  return { tabId, serverName: server.name, sessionDir };
});

ipcMain.handle('server-exec', async (_event, serverId: string, command: string): Promise<{ success: boolean; output: string; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { success: false, output: '', error: 'Server nicht gefunden' };
  return sshExecWithCreds(server, command);
});

// ─── Server Intelligence (v1.1.29) ───────────────────────────────────────────
type ServerSysinfo = import('../shared/types').ServerSysinfo;

function getServerSessionDir(serverId: string): string {
  return path.join(os.homedir(), '.claude', 'server-sessions', serverId);
}

async function setupSshKeyOnServer(server: ServerCredential): Promise<{ success: boolean; error?: string }> {
  const sessionDir = getServerSessionDir(server.id);
  const doneFile = path.join(sessionDir, 'ssh-key-setup.done');
  if (fs.existsSync(doneFile)) return { success: true };

  // Find local public key
  const pubKeyPaths = [
    path.join(os.homedir(), '.ssh', 'id_ed25519.pub'),
    path.join(os.homedir(), '.ssh', 'id_rsa.pub'),
    path.join(os.homedir(), '.ssh', 'id_ecdsa.pub'),
  ];
  const pubKeyPath = pubKeyPaths.find(p => fs.existsSync(p));
  if (!pubKeyPath) return { success: false, error: 'Kein lokaler SSH-Schlüssel (~/.ssh/id_*.pub) gefunden' };

  const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
  // Escape for shell: wrap in single quotes, escape existing single quotes
  const escapedKey = pubKey.replace(/'/g, "'\\''");
  const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && echo OK`;

  const result = await sshExecWithCreds(server, cmd, 20000);
  if (result.success) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(doneFile, new Date().toISOString());
  }
  return result.success ? { success: true } : { success: false, error: result.error };
}

ipcMain.handle('fetch-server-sysinfo', async (_event, serverId: string): Promise<ServerSysinfo | { error: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { error: 'Server nicht gefunden' };

  const script = `python3 -c "
import json, os, time
try:
    with open('/proc/uptime') as f: uptime=int(float(f.read().split()[0]))
except: uptime=0
try:
    with open('/proc/meminfo') as f:
        lines={l.split(':')[0]:int(l.split(':')[1].strip().split()[0]) for l in f if ':' in l}
    mem_total=lines.get('MemTotal',0)//1024
    mem_avail=lines.get('MemAvailable',lines.get('MemFree',0))//1024
    mem_used=mem_total-mem_avail
except: mem_total=mem_used=0
try:
    import shutil
    d=shutil.disk_usage('/')
    disk_total=d.total//1073741824
    disk_used=d.used//1073741824
except: disk_total=disk_used=0
try:
    with open('/proc/stat') as f:
        cpu=f.readline().split()
    idle=int(cpu[4])
    total=sum(int(x) for x in cpu[1:])
    time.sleep(0.2)
    with open('/proc/stat') as f:
        cpu2=f.readline().split()
    idle2=int(cpu2[4])
    total2=sum(int(x) for x in cpu2[1:])
    cpu_pct=round((1-(idle2-idle)/(total2-total))*100,1)
except: cpu_pct=0
try:
    with open('/etc/os-release') as f:
        osrel={l.split('=')[0]:l.split('=')[1].strip().strip(chr(34)) for l in f if '=' in l}
    os_name=osrel.get('PRETTY_NAME',osrel.get('NAME','Linux'))
except: os_name='Linux'
import socket
print(json.dumps({'hostname':socket.gethostname(),'os':os_name,'cpu':cpu_pct,'mem':{'used':mem_used,'total':mem_total},'disk':{'used':disk_used,'total':disk_total},'uptime':uptime,'fetchedAt':'$(date -u +%Y-%m-%dT%H:%M:%SZ)'}))
" 2>/dev/null || echo '{"error":"python3 not available"}'`;

  const result = await sshExecWithCreds(server, script, 15000);
  if (!result.success) return { error: result.error || 'SSH-Fehler' };

  try {
    const parsed = JSON.parse(result.output);
    if (parsed.error) {
      // Fallback: simpler bash-based sysinfo
      const bashScript = `echo '{"hostname":"'$(hostname)'","os":"'$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)'",' \
'"cpu":'$(top -bn1 2>/dev/null | grep -E "^%?Cpu" | awk '{gsub(/%us,|%id,/,""); print $2}' | head -1 || echo 0)',' \
'"mem":{"used":'$(free -m 2>/dev/null | awk "/^Mem:/{print \$3}" || echo 0)',"total":'$(free -m 2>/dev/null | awk "/^Mem:/{print \$2}" || echo 0)'},' \
'"disk":{"used":'$(df -BG / 2>/dev/null | awk "NR==2{gsub(/G/,\"\",$3);print \$3}" || echo 0)',"total":'$(df -BG / 2>/dev/null | awk "NR==2{gsub(/G/,\"\",$2);print \$2}" || echo 0)'},' \
'"uptime":'$(cat /proc/uptime 2>/dev/null | awk "{print int(\$1)}" || echo 0)',' \
'"fetchedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'`;
      const r2 = await sshExecWithCreds(server, bashScript, 15000);
      if (!r2.success) return { error: r2.error || 'Bash-Fallback fehlgeschlagen' };
      const p2 = JSON.parse(r2.output);
      const sysinfo: ServerSysinfo = {
        hostname: p2.hostname || server.host,
        os: p2.os || 'Linux',
        cpu: Number(p2.cpu) || 0,
        mem: { used: Number(p2.mem?.used) || 0, total: Number(p2.mem?.total) || 0 },
        disk: { used: Number(p2.disk?.used) || 0, total: Number(p2.disk?.total) || 0 },
        uptime: Number(p2.uptime) || 0,
        fetchedAt: p2.fetchedAt || new Date().toISOString(),
      };
      const sessionDir = getServerSessionDir(serverId);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'sysinfo.json'), JSON.stringify(sysinfo, null, 2));
      return sysinfo;
    }
    const sysinfo: ServerSysinfo = {
      hostname: parsed.hostname || server.host,
      os: parsed.os || 'Linux',
      cpu: Number(parsed.cpu) || 0,
      mem: { used: Number(parsed.mem?.used) || 0, total: Number(parsed.mem?.total) || 0 },
      disk: { used: Number(parsed.disk?.used) || 0, total: Number(parsed.disk?.total) || 0 },
      uptime: Number(parsed.uptime) || 0,
      fetchedAt: parsed.fetchedAt || new Date().toISOString(),
    };
    const sessionDir = getServerSessionDir(serverId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'sysinfo.json'), JSON.stringify(sysinfo, null, 2));
    return sysinfo;
  } catch {
    return { error: 'JSON-Parsing fehlgeschlagen: ' + result.output.slice(0, 200) };
  }
});

ipcMain.handle('load-server-sysinfo', async (_event, serverId: string): Promise<ServerSysinfo | null> => {
  try {
    const sysinfoPath = path.join(getServerSessionDir(serverId), 'sysinfo.json');
    if (!fs.existsSync(sysinfoPath)) return null;
    return JSON.parse(fs.readFileSync(sysinfoPath, 'utf8')) as ServerSysinfo;
  } catch {
    return null;
  }
});

ipcMain.handle('setup-ssh-key', async (_event, serverId: string): Promise<{ success: boolean; error?: string }> => {
  const servers = loadServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) return { success: false, error: 'Server nicht gefunden' };
  return setupSshKeyOnServer(server);
});

ipcMain.handle('save-server-purpose', async (_event, serverId: string, purpose: string): Promise<void> => {
  const servers = loadServers();
  const idx = servers.findIndex(s => s.id === serverId);
  if (idx < 0) return;
  servers[idx] = { ...servers[idx], purpose, updatedAt: new Date().toISOString() };
  saveServers(servers);
});

// ─── Todos (v1.1.26) ─────────────────────────────────────────────────────────
const TODOS_PATH = path.join(os.homedir(), '.claude', 'todos.json');

async function loadTodos(): Promise<Todo[]> {
  try {
    return JSON.parse(await fs.promises.readFile(TODOS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveTodos(todos: Todo[]): Promise<void> {
  await fs.promises.writeFile(TODOS_PATH, JSON.stringify(todos, null, 2));
  mainWindow?.webContents.send('todos-updated');
}

ipcMain.handle('get-todos', async (): Promise<Todo[]> => {
  return loadTodos();
});

ipcMain.handle('add-todo', async (_event, t: { title: string; description?: string }): Promise<Todo> => {
  const todos = await loadTodos();
  const todo: Todo = {
    id: `todo-${Date.now()}`,
    title: t.title,
    description: t.description,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  todos.unshift(todo);
  await saveTodos(todos);
  return todo;
});

ipcMain.handle('update-todo', async (_event, id: string, updates: Partial<Todo>): Promise<Todo> => {
  const todos = await loadTodos();
  const i = todos.findIndex(t => t.id === id);
  if (i < 0) throw new Error('Todo not found');
  todos[i] = { ...todos[i], ...updates };
  await saveTodos(todos);
  return todos[i];
});

ipcMain.handle('delete-todo', async (_event, id: string): Promise<{ success: boolean }> => {
  const todos = await loadTodos();
  await saveTodos(todos.filter(t => t.id !== id));
  return { success: true };
});

// ── Password Manager (v1.1.35) ──────────────────────────────────────────────

const PASSWORDS_PATH = path.join(os.homedir(), '.claude', 'passwords.json');

async function loadPasswords(): Promise<PasswordEntry[]> {
  try {
    return JSON.parse(await fs.promises.readFile(PASSWORDS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function savePasswords(entries: PasswordEntry[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(PASSWORDS_PATH), { recursive: true });
  await fs.promises.writeFile(PASSWORDS_PATH, JSON.stringify(entries, null, 2));
}

ipcMain.handle('get-passwords', async (): Promise<PasswordEntry[]> => {
  return loadPasswords();
});

ipcMain.handle('save-password', async (_event, entry: Partial<PasswordEntry>, password: string): Promise<PasswordEntry> => {
  const entries = await loadPasswords();
  const now = new Date().toISOString();
  if (entry.id) {
    // Update existing
    const i = entries.findIndex(e => e.id === entry.id);
    if (i >= 0) {
      entries[i] = { ...entries[i], ...entry, updatedAt: now };
      await savePasswords(entries);
      if (password) await vaultSet(`pw:${entries[i].id}:password`, password);
      return entries[i];
    }
  }
  // Create new
  const newEntry: PasswordEntry = {
    id: `pw-${Date.now()}`,
    name: entry.name || '',
    url: entry.url,
    username: entry.username || '',
    category: entry.category || 'Sonstiges',
    notes: entry.notes,
    createdAt: now,
    updatedAt: now,
  };
  entries.unshift(newEntry);
  await savePasswords(entries);
  if (password) await vaultSet(`pw:${newEntry.id}:password`, password);
  return newEntry;
});

ipcMain.handle('remove-password', async (_event, id: string): Promise<void> => {
  const entries = await loadPasswords();
  await savePasswords(entries.filter(e => e.id !== id));
  await vaultDelete(`pw:${id}:password`);
});

ipcMain.handle('get-password-secret', async (_event, id: string): Promise<{ password: string | null }> => {
  const password = await vaultGet(`pw:${id}:password`);
  return { password };
});

// ── System Credentials View (v1.1.36) ───────────────────────────────────────
// Read-only Übersicht aller von Claude MC verwalteten Vault-Credentials.
// Zeigt Mail-, Server- und GitHub-Credentials im Passwort-Manager an.

export type SystemCredentialType =
  | 'mail-password'
  | 'mail-oauth2'
  | 'server-password'
  | 'server-passphrase'
  | 'server-apitoken'
  | 'github-token';

export interface SystemCredential {
  vaultKey: string;
  type: SystemCredentialType;
  category: 'Mail' | 'Server' | 'GitHub';
  label: string;       // Display-Name (Account/Server-Name)
  username: string;    // Benutzer / Login
  detail?: string;     // Zusatzinfo (Host, URL, OAuth-Status, etc.)
  accountId: string;
}

ipcMain.handle('get-system-credentials', async (): Promise<SystemCredential[]> => {
  const result: SystemCredential[] = [];

  // Mail-Accounts
  try {
    const mailAccounts = loadMailAccounts();
    for (const acc of mailAccounts) {
      if (acc.authType === 'oauth2') {
        if (vaultHas(`mail:${acc.id}:oauth2`)) {
          result.push({
            vaultKey: `mail:${acc.id}:oauth2`,
            type: 'mail-oauth2',
            category: 'Mail',
            label: acc.name,
            username: acc.user,
            detail: `${acc.host} · OAuth2 (Office 365)`,
            accountId: acc.id,
          });
        }
      } else {
        if (vaultHas(`mail:${acc.id}:password`)) {
          result.push({
            vaultKey: `mail:${acc.id}:password`,
            type: 'mail-password',
            category: 'Mail',
            label: acc.name,
            username: acc.user,
            detail: `${acc.host}:${acc.port}${acc.ssl ? ' SSL' : ''}`,
            accountId: acc.id,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[system-credentials] mail accounts failed:', (err as Error).message);
  }

  // Server-Credentials
  try {
    const servers = loadServers();
    for (const s of servers) {
      const baseLabel = s.name;
      const conn = `${s.user}@${s.host}:${s.port}`;
      if (vaultHas(`server:${s.id}:password`)) {
        result.push({
          vaultKey: `server:${s.id}:password`,
          type: 'server-password',
          category: 'Server',
          label: `${baseLabel} (SSH-Passwort)`,
          username: s.user,
          detail: conn,
          accountId: s.id,
        });
      }
      if (vaultHas(`server:${s.id}:sshPassphrase`)) {
        result.push({
          vaultKey: `server:${s.id}:sshPassphrase`,
          type: 'server-passphrase',
          category: 'Server',
          label: `${baseLabel} (Key-Passphrase)`,
          username: s.user,
          detail: s.sshKeyPath ? `${conn} · ${s.sshKeyPath}` : conn,
          accountId: s.id,
        });
      }
      if (vaultHas(`server:${s.id}:apiToken`)) {
        result.push({
          vaultKey: `server:${s.id}:apiToken`,
          type: 'server-apitoken',
          category: 'Server',
          label: `${baseLabel} (API-Token)`,
          username: s.user,
          detail: conn,
          accountId: s.id,
        });
      }
    }
  } catch (err) {
    console.warn('[system-credentials] servers failed:', (err as Error).message);
  }

  // GitHub-Accounts
  try {
    const ghAccounts = await loadGitHubAccounts();
    for (const acc of ghAccounts) {
      if (vaultHas(`gh:${acc.id}:token`)) {
        result.push({
          vaultKey: `gh:${acc.id}:token`,
          type: 'github-token',
          category: 'GitHub',
          label: acc.displayName || acc.username,
          username: acc.username,
          detail: 'Personal Access Token',
          accountId: acc.id,
        });
      }
    }
  } catch (err) {
    console.warn('[system-credentials] github accounts failed:', (err as Error).message);
  }

  return result;
});

const ALLOWED_VAULT_PREFIXES = ['mail:', 'server:', 'gh:'];

ipcMain.handle('get-vault-secret', async (_event, vaultKey: string): Promise<{ secret: string | null; error?: string }> => {
  if (typeof vaultKey !== 'string' || !ALLOWED_VAULT_PREFIXES.some(p => vaultKey.startsWith(p))) {
    return { secret: null, error: 'unauthorized vault key' };
  }
  const secret = vaultGet(vaultKey);
  return { secret };
});

// ── GitHub Account Manager (v1.1.36) ────────────────────────────────────────

const GH_ACCOUNTS_PATH = path.join(os.homedir(), '.claude', 'github-accounts.json');

async function loadGitHubAccounts(): Promise<GitHubAccount[]> {
  try {
    return JSON.parse(await fs.promises.readFile(GH_ACCOUNTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveGitHubAccounts(accounts: GitHubAccount[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(GH_ACCOUNTS_PATH), { recursive: true });
  await fs.promises.writeFile(GH_ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

/**
 * Returns GIT_ASKPASS env vars for the GitHub account matching the repo URL.
 * Returns {} if no account is found (falls back to system git config).
 */
async function getGitCredentialEnv(repoUrl: string): Promise<Record<string, string>> {
  try {
    // Parse owner from https://github.com/:owner/repo or similar
    const match = repoUrl.match(/github\.com[/:]([^/]+)/i);
    if (!match) return {};
    const owner = match[1].toLowerCase();

    const accounts = await loadGitHubAccounts();
    const account = accounts.find(a => a.username.toLowerCase() === owner);
    if (!account) return {};

    const token = await vaultGet(`gh:${account.id}:token`);
    if (!token) return {};

    // Write a temp askpass script
    const tmpScript = path.join(os.tmpdir(), `ghcred-${account.id}-${Date.now()}.sh`);
    const escapedUser = account.username.replace(/'/g, "'\\''");
    const escapedToken = token.replace(/'/g, "'\\''");
    fs.writeFileSync(
      tmpScript,
      `#!/bin/sh\nif echo "$1" | grep -iq "username"; then echo '${escapedUser}'; else echo '${escapedToken}'; fi`,
      { mode: 0o700 }
    );
    // Auto-clean after 60 seconds
    setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch { /* ignore */ } }, 60000);

    return {
      GIT_ASKPASS: tmpScript,
      GIT_TERMINAL_PROMPT: '0',
    };
  } catch {
    return {};
  }
}

ipcMain.handle('get-github-accounts', async (): Promise<GitHubAccount[]> => {
  return loadGitHubAccounts();
});

// ── gh CLI Bridge ──────────────────────────────────────────────────────────
// Lets the renderer reuse a token that the user already has in `gh auth`
// instead of asking them to generate a new PAT.
interface GhAccount {
  username: string;
  scopes: string[];
  active: boolean;
  protocol?: string;
}

function findGhBinary(): string | null {
  const candidates = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

ipcMain.handle('gh-cli-list-accounts', async (): Promise<GhAccount[]> => {
  const gh = findGhBinary();
  if (!gh) return [];
  try {
    const { stdout } = await execAsync(`"${gh}" auth status`, { encoding: 'utf-8' });
    // `gh auth status` puts multiple accounts under one `github.com` heading.
    // We split on each "Logged in to github.com account NAME" anchor and look
    // at the lines that follow up to the next anchor for that account's props.
    const accounts: GhAccount[] = [];
    const anchorRe = /Logged in to github\.com account (\S+)\s*(?:\([^)]*\))?/g;
    const matches: Array<{ user: string; idx: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(stdout)) !== null) {
      matches.push({ user: m[1], idx: m.index });
    }
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].idx;
      const end = i + 1 < matches.length ? matches[i + 1].idx : stdout.length;
      const slice = stdout.slice(start, end);
      const activeMatch = /Active account:\s*(true|false)/.exec(slice);
      const scopesMatch = /Token scopes:\s*'([^']*)'/.exec(slice);
      const protocolMatch = /Git operations protocol:\s*(\S+)/.exec(slice);
      accounts.push({
        username: matches[i].user,
        scopes: scopesMatch ? scopesMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : [],
        active: activeMatch ? activeMatch[1] === 'true' : false,
        protocol: protocolMatch?.[1],
      });
    }
    return accounts;
  } catch {
    return [];
  }
});

ipcMain.handle('gh-cli-get-token', async (_e, username: string): Promise<{ token: string | null; error?: string }> => {
  const gh = findGhBinary();
  if (!gh) return { token: null, error: 'gh CLI nicht installiert' };
  try {
    const { stdout } = await execAsync(`"${gh}" auth token --user ${username.replace(/[^a-zA-Z0-9_-]/g, '')}`, { encoding: 'utf-8' });
    const token = stdout.trim();
    return { token: token || null };
  } catch (err) {
    return { token: null, error: (err as Error).message };
  }
});

// ── Auth-Error-Detection ────────────────────────────────────────────────────
// Helper to recognize a git auth failure and extract the owner from it.
ipcMain.handle('parse-git-auth-error', async (_e, msg: string): Promise<{ isAuthError: boolean; owner?: string; repo?: string }> => {
  if (!msg) return { isAuthError: false };
  const patterns = [
    /Repository not found/i,
    /Permission denied/i,
    /Authentication failed/i,
    /403/,
    /could not read Username/i,
    /remote: Invalid username or password/i,
  ];
  const isAuthError = patterns.some(p => p.test(msg));
  if (!isAuthError) return { isAuthError: false };
  // Extract github.com/<owner>/<repo> from the message
  const urlMatch = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/\s'"]|$)/i.exec(msg);
  if (urlMatch) return { isAuthError: true, owner: urlMatch[1], repo: urlMatch[2] };
  return { isAuthError: true };
});

ipcMain.handle('save-github-account', async (_event, account: Partial<GitHubAccount>, token: string): Promise<GitHubAccount> => {
  const accounts = await loadGitHubAccounts();
  const now = new Date().toISOString();
  if (account.id) {
    // Update existing
    const i = accounts.findIndex(a => a.id === account.id);
    if (i >= 0) {
      accounts[i] = { ...accounts[i], ...account, hasToken: accounts[i].hasToken };
      if (token) {
        await vaultSet(`gh:${accounts[i].id}:token`, token);
        accounts[i].hasToken = true;
      }
      await saveGitHubAccounts(accounts);
      return accounts[i];
    }
  }
  // Update-by-username: prevent dupes when the user re-imports the same gh
  // account multiple times (e.g. retry-clicks in the auth-error modal).
  if (account.username) {
    const existing = accounts.find(a => a.username.toLowerCase() === account.username!.toLowerCase());
    if (existing) {
      if (account.displayName !== undefined) existing.displayName = account.displayName;
      if (token) {
        await vaultSet(`gh:${existing.id}:token`, token);
        existing.hasToken = true;
      }
      await saveGitHubAccounts(accounts);
      return existing;
    }
  }
  // Create new
  const newAccount: GitHubAccount = {
    id: `gh-${Date.now()}`,
    username: account.username || '',
    displayName: account.displayName,
    hasToken: false,
    createdAt: now,
  };
  if (token) {
    await vaultSet(`gh:${newAccount.id}:token`, token);
    newAccount.hasToken = true;
  }
  accounts.push(newAccount);
  await saveGitHubAccounts(accounts);
  return newAccount;
});

ipcMain.handle('remove-github-account', async (_event, id: string): Promise<void> => {
  const accounts = await loadGitHubAccounts();
  await saveGitHubAccounts(accounts.filter(a => a.id !== id));
  await vaultDelete(`gh:${id}:token`);
});

ipcMain.handle('test-github-account', async (_event, id: string): Promise<{ success: boolean; login?: string; error?: string }> => {
  try {
    const token = await vaultGet(`gh:${id}:token`);
    if (!token) return { success: false, error: 'Kein Token vorhanden' };

    const result = await new Promise<{ success: boolean; login?: string; error?: string }>((resolve) => {
      const req = https.request(
        'https://api.github.com/user',
        {
          method: 'GET',
          headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'ClaudeMC/1.0',
            'Accept': 'application/vnd.github.v3+json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(body);
                resolve({ success: true, login: data.login });
              } catch {
                resolve({ success: false, error: 'JSON parse error' });
              }
            } else {
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          });
        }
      );
      req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.end();
    });

    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── Task Server connections ────────────────────────────────────────────────
const TASK_SERVERS_PATH = path.join(os.homedir(), '.claude', 'task-servers.json');

async function loadTaskServers(): Promise<import('../shared/types').TaskServerConnection[]> {
  try {
    return JSON.parse(await fs.promises.readFile(TASK_SERVERS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveTaskServers(servers: import('../shared/types').TaskServerConnection[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(TASK_SERVERS_PATH), { recursive: true });
  await fs.promises.writeFile(TASK_SERVERS_PATH, JSON.stringify(servers, null, 2));
}

// Helper: do an HTTP(S) request with optional Bearer token. Returns parsed JSON
// on 2xx, throws on network/timeout error, returns { __status, __body } on
// non-2xx so the caller can decide what to do.
function taskServerRequest(
  baseUrl: string,
  token: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(pathname, baseUrl); } catch { reject(new Error(`Ungültige URL: ${baseUrl}`)); return; }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = lib.request({
      method, headers,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) {
          try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
        } else {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* keep raw */ }
          resolve({ __status: code, __body: parsed });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

ipcMain.handle('get-task-servers', async (): Promise<import('../shared/types').TaskServerConnection[]> => loadTaskServers());

ipcMain.handle('save-task-server', async (_e, data: Partial<import('../shared/types').TaskServerConnection>, token?: string): Promise<import('../shared/types').TaskServerConnection> => {
  const servers = await loadTaskServers();
  const now = new Date().toISOString();
  let server: import('../shared/types').TaskServerConnection;
  if (data.id) {
    const idx = servers.findIndex(s => s.id === data.id);
    if (idx < 0) throw new Error('Task-Server nicht gefunden');
    server = { ...servers[idx], ...data, updatedAt: now };
    servers[idx] = server;
  } else {
    server = {
      id: crypto.randomUUID(),
      name: data.name || 'Neuer Task-Server',
      baseUrl: data.baseUrl || '',
      hasToken: false,
      createdAt: now,
      updatedAt: now,
    };
    servers.push(server);
  }
  if (token !== undefined) {
    if (token) { vaultSet(`tasksrv:${server.id}:token`, token); server.hasToken = true; }
    else { vaultDelete(`tasksrv:${server.id}:token`); server.hasToken = false; }
  } else {
    server.hasToken = vaultHas(`tasksrv:${server.id}:token`);
  }
  const idx = servers.findIndex(s => s.id === server.id);
  if (idx >= 0) servers[idx] = server;
  await saveTaskServers(servers);
  return server;
});

ipcMain.handle('remove-task-server', async (_e, id: string): Promise<void> => {
  const servers = (await loadTaskServers()).filter(s => s.id !== id);
  await saveTaskServers(servers);
  vaultDeletePrefix(`tasksrv:${id}:`);
});

ipcMain.handle('test-task-server', async (_e, id: string): Promise<{ success: boolean; version?: string; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { success: false, error: 'Task-Server nicht gefunden' };
  try {
    const res = await taskServerRequest(server.baseUrl, null, 'GET', '/health', undefined, 8000) as { ok?: boolean; version?: string; __status?: number };
    if (res?.__status) return { success: false, error: `HTTP ${res.__status}` };
    if (res?.ok) return { success: true, version: res.version };
    return { success: false, error: 'Unerwartete /health-Antwort' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('task-server-list-jobs', async (_e, id: string): Promise<import('../shared/types').TaskJob[] | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'GET', '/jobs') as import('../shared/types').TaskJob[] | { __status: number; __body: unknown };
    if ('__status' in res) return { error: `HTTP ${res.__status}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-create-job', async (_e, id: string, body: { script: string; language?: import('../shared/types').TaskJobLanguage; env?: Record<string, string>; name?: string; meta?: import('../shared/types').TaskJobMeta }): Promise<import('../shared/types').TaskJob | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'POST', '/jobs', body) as import('../shared/types').TaskJob | { __status: number; __body: unknown };
    if ('__status' in res) return { error: `HTTP ${res.__status}: ${JSON.stringify(res.__body)}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-get-job', async (_e, id: string, jobId: string): Promise<import('../shared/types').TaskJob | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}`) as import('../shared/types').TaskJob | { __status: number; __body: unknown };
    if ('__status' in res) return { error: `HTTP ${res.__status}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-delete-job', async (_e, id: string, jobId: string): Promise<{ deleted: boolean; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { deleted: false, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { deleted: false, error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'DELETE', `/jobs/${encodeURIComponent(jobId)}`) as { deleted?: boolean; __status?: number };
    if (res?.__status) return { deleted: false, error: `HTTP ${res.__status}` };
    return { deleted: !!res?.deleted };
  } catch (err) {
    return { deleted: false, error: (err as Error).message };
  }
});

ipcMain.handle('task-server-delete-jobs-bulk', async (_e, id: string, statuses: string[] = ['done', 'failed', 'killed']): Promise<{ deleted: number; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { deleted: 0, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { deleted: 0, error: 'Kein Token im Vault' };
  try {
    const qs = `status=${encodeURIComponent(statuses.join(','))}`;
    const res = await taskServerRequest(server.baseUrl, token, 'DELETE', `/jobs?${qs}`) as { deleted?: number; __status?: number };
    if (res?.__status) return { deleted: 0, error: `HTTP ${res.__status}` };
    return { deleted: res?.deleted || 0 };
  } catch (err) {
    return { deleted: 0, error: (err as Error).message };
  }
});

ipcMain.handle('task-server-kill-job', async (_e, id: string, jobId: string): Promise<{ killed: boolean; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { killed: false, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { killed: false, error: 'Kein Token im Vault' };
  try {
    // `?keep=1` → kill but don't delete the job (keeps history in RTaskMC)
    const res = await taskServerRequest(server.baseUrl, token, 'DELETE', `/jobs/${encodeURIComponent(jobId)}?keep=1`) as { killed?: boolean; __status?: number };
    if (res?.__status) return { killed: false, error: `HTTP ${res.__status}` };
    return { killed: !!res?.killed };
  } catch (err) {
    return { killed: false, error: (err as Error).message };
  }
});

// SSE log stream — pipes the server's SSE feed via 'task-job-log-chunk' events
// to the renderer. Each subscription is tracked by streamId so multiple
// jobs can stream in parallel and the renderer can cancel them.
const taskJobLogStreams = new Map<string, () => void>();

ipcMain.handle('task-server-stream-log', async (event, id: string, jobId: string, streamId: string): Promise<{ ok: boolean; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { ok: false, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { ok: false, error: 'Kein Token im Vault' };

  const url = new URL(`/jobs/${encodeURIComponent(jobId)}/log`, server.baseUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request({
    method: 'GET',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      try { event.sender.send('task-job-log-chunk', { streamId, error: `HTTP ${res.statusCode}` }); } catch { /* ignore */ }
      try { event.sender.send('task-job-log-chunk', { streamId, end: true }); } catch { /* ignore */ }
      return;
    }
    // SSE parser: accumulate, split on \n\n
    let buffer = '';
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split('\n');
        let isEnd = false;
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event: end')) isEnd = true;
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          else if (line.startsWith(':')) { /* comment */ }
        }
        if (isEnd) {
          try { event.sender.send('task-job-log-chunk', { streamId, end: true }); } catch { /* ignore */ }
        } else if (dataLines.length > 0) {
          const text = dataLines.join('\n');
          try { event.sender.send('task-job-log-chunk', { streamId, text }); } catch { /* ignore */ }
        }
      }
    });
    res.on('end', () => {
      try { event.sender.send('task-job-log-chunk', { streamId, end: true }); } catch { /* ignore */ }
      taskJobLogStreams.delete(streamId);
    });
    res.on('error', (err: Error) => {
      try { event.sender.send('task-job-log-chunk', { streamId, error: err.message, end: true }); } catch { /* ignore */ }
      taskJobLogStreams.delete(streamId);
    });
  });
  req.on('error', (err) => {
    try { event.sender.send('task-job-log-chunk', { streamId, error: err.message, end: true }); } catch { /* ignore */ }
    taskJobLogStreams.delete(streamId);
  });
  req.end();
  taskJobLogStreams.set(streamId, () => { try { req.destroy(); } catch { /* ignore */ } });
  return { ok: true };
});

ipcMain.handle('task-server-stop-stream', async (_e, streamId: string): Promise<void> => {
  const fn = taskJobLogStreams.get(streamId);
  if (fn) { fn(); taskJobLogStreams.delete(streamId); }
});

ipcMain.handle('task-server-list-schedules', async (_e, id: string): Promise<import('../shared/types').TaskSchedule[] | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'GET', '/schedules') as import('../shared/types').TaskSchedule[] | { __status: number };
    if ('__status' in res) return { error: `HTTP ${res.__status}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-create-schedule', async (_e, id: string, body: { cronExpr: string; script: string; language?: import('../shared/types').TaskJobLanguage; name?: string; meta?: import('../shared/types').TaskJobMeta }): Promise<import('../shared/types').TaskSchedule | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'POST', '/schedules', body) as import('../shared/types').TaskSchedule | { __status: number; __body: unknown };
    if ('__status' in res) return { error: `HTTP ${res.__status}: ${JSON.stringify(res.__body)}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-update-schedule', async (_e, id: string, scheduleId: string, patch: Partial<{ cronExpr: string; enabled: boolean; name: string; script: string }>): Promise<import('../shared/types').TaskSchedule | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    // PATCH: send via taskServerRequest. The helper only knows GET/POST/DELETE.
    // Workaround: replicate the request inline.
    const u = new URL('/schedules/' + encodeURIComponent(scheduleId), server.baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(patch);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = lib.request({
        method: 'PATCH',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      }, (response) => {
        let buf = '';
        response.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: buf }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(payload);
      req.end();
    });
    if (res.status >= 200 && res.status < 300) return JSON.parse(res.body);
    return { error: `HTTP ${res.status}: ${res.body}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('task-server-delete-schedule', async (_e, id: string, scheduleId: string): Promise<{ deleted: boolean; error?: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { deleted: false, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { deleted: false, error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'DELETE', `/schedules/${encodeURIComponent(scheduleId)}`) as { deleted?: boolean; __status?: number };
    if (res?.__status) return { deleted: false, error: `HTTP ${res.__status}` };
    return { deleted: !!res?.deleted };
  } catch (err) {
    return { deleted: false, error: (err as Error).message };
  }
});

ipcMain.handle('task-server-list-artifacts', async (_e, id: string, jobId: string): Promise<import('../shared/types').TaskArtifact[] | { error: string }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { error: 'Kein Token im Vault' };
  try {
    const res = await taskServerRequest(server.baseUrl, token, 'GET', `/jobs/${encodeURIComponent(jobId)}/artifacts`) as import('../shared/types').TaskArtifact[] | { __status: number };
    if ('__status' in res) return { error: `HTTP ${res.__status}` };
    return res;
  } catch (err) {
    return { error: (err as Error).message };
  }
});

// Download artifact: show save dialog, stream from server to chosen file.
ipcMain.handle('task-server-download-artifact', async (_e, id: string, jobId: string, name: string): Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }> => {
  const server = (await loadTaskServers()).find(s => s.id === id);
  if (!server) return { success: false, error: 'Task-Server nicht gefunden' };
  const token = vaultGet(`tasksrv:${id}:token`);
  if (!token) return { success: false, error: 'Kein Token im Vault' };

  const saveResult = await dialog.showSaveDialog(mainWindow!, {
    title: `Artefakt "${name}" speichern`,
    defaultPath: name,
  });
  if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(`/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`, server.baseUrl); }
    catch { resolve({ success: false, error: 'Ungültige URL' }); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ success: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` }));
        return;
      }
      const stream = fs.createWriteStream(saveResult.filePath!);
      res.pipe(stream);
      stream.on('finish', () => resolve({ success: true, path: saveResult.filePath }));
      stream.on('error', (err) => resolve({ success: false, error: err.message }));
    });
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(60000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    req.end();
  });
});

// Parse `# @key: value` lines from the first 30 lines of a script (frontmatter).
function parseTaskFrontmatter(content: string): { description?: string; serverHint?: string; envHints?: string[] } {
  const out: { description?: string; serverHint?: string; envHints?: string[] } = {};
  const lines = content.split('\n').slice(0, 30);
  // Accept both `# @key:` (bash) and `// @key:` (JS) prefixes.
  const re = /^\s*(?:#|\/\/)\s*@(\w+)\s*:\s*(.+?)\s*$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'desc' || key === 'description') out.description = value;
    else if (key === 'server') out.serverHint = value;
    else if (key === 'env') out.envHints = value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

// Identify the script language by extension. Default to bash for unknown.
function detectTaskLanguage(filename: string): 'bash' | 'node' {
  return filename.toLowerCase().endsWith('.js') ? 'node' : 'bash';
}

// Inject/update the RTaskMC skill section in a project's CLAUDE.md so that
// any Claude (terminal / sub-agent / orchestrator) reading the file knows
// about the available tasks and how to trigger them.
const TASKS_MARKER_START = '<!-- AUTO-RTASKMC-START -->';
const TASKS_MARKER_END = '<!-- AUTO-RTASKMC-END -->';

async function syncClaudeMdTasksSection(projectPath: string): Promise<{ updated: boolean; tasksCount: number }> {
  const tasksDir = path.join(projectPath, 'tasks');
  let entries: string[];
  try { entries = await fs.promises.readdir(tasksDir); } catch { return { updated: false, tasksCount: 0 }; }
  const scripts = entries.filter(e => e.endsWith('.sh'));
  if (scripts.length === 0) return { updated: false, tasksCount: 0 };

  const tasks: Array<{ name: string; description?: string; serverHint?: string }> = [];
  for (const s of scripts) {
    const content = await fs.promises.readFile(path.join(tasksDir, s), 'utf-8').catch(() => '');
    const meta = parseTaskFrontmatter(content);
    tasks.push({ name: s.replace(/\.sh$/, ''), description: meta.description, serverHint: meta.serverHint });
  }

  const taskList = tasks.map(t => {
    const desc = t.description ? ` — ${t.description}` : '';
    const srv = t.serverHint ? ` *(server: ${t.serverHint})*` : '';
    return `- \`${t.name}\`${desc}${srv}`;
  }).join('\n');

  const section = `${TASKS_MARKER_START}
## RTaskMC Skill — Remote Tasks

Dieses Projekt hat ausführbare Tasks in \`tasks/*.sh\`. Wenn der Nutzer sagt
"starte X als RTask" / "run X remote" / "führ den deploy-Task aus", dann nutze
das vorhandene CLI:

\`\`\`bash
claudemc-task list                                 # verfügbare Tasks listen
claudemc-task run <name>                           # Job feuern (Output im RTaskMC-Tab)
claudemc-task run <name> --wait                    # feuern + live mitlesen, Exit-Code = Job-Exit
claudemc-task run <name> --env KEY=VAL             # einen Secret-Wert ins Job-Env injizieren
claudemc-task run <name> --env-file ./.env         # KEY=VAL aus Datei lesen (--env überschreibt)
claudemc-task status <jobId>                       # Status eines Jobs (one-liner)
claudemc-task log <jobId>                          # Log eines Jobs (backlog + live bis Ende)
\`\`\`

**Verfügbare Tasks:**
${taskList}

Output erscheint im **RTaskMC-Tab** der ClaudeMC-App mit Projekt-Badge. Neue Tasks
können als \`tasks/<name>.sh\` angelegt werden (optional Frontmatter \`# @desc:\`,
\`# @server:\`, \`# @env:\`).
${TASKS_MARKER_END}`;

  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  let existing = '';
  try { existing = await fs.promises.readFile(claudeMdPath, 'utf-8'); } catch { /* no CLAUDE.md yet — create */ }

  let next: string;
  const startIdx = existing.indexOf(TASKS_MARKER_START);
  const endIdx = existing.indexOf(TASKS_MARKER_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    // Replace existing section
    next = existing.slice(0, startIdx) + section + existing.slice(endIdx + TASKS_MARKER_END.length);
  } else {
    // Append (or create file)
    next = existing
      ? `${existing.replace(/\s+$/, '')}\n\n${section}\n`
      : `# ${path.basename(projectPath)}\n\n${section}\n`;
  }

  if (next === existing) return { updated: false, tasksCount: tasks.length };
  await fs.promises.writeFile(claudeMdPath, next, 'utf-8');
  return { updated: true, tasksCount: tasks.length };
}

ipcMain.handle('sync-claudemd-tasks-section', async (_e, projectPath: string) => {
  return syncClaudeMdTasksSection(projectPath);
});

ipcMain.handle('sync-all-claudemd-tasks-sections', async () => {
  const projectsCfg = await loadProjectConfig();
  const coworkCfg = await loadCoworkConfig();
  const results: Array<{ projectPath: string; tasksCount: number; updated: boolean }> = [];
  const roots = [
    ...projectsCfg.projects.map(p => p.path),
    ...coworkCfg.repositories.map(r => r.localPath),
  ];
  for (const root of roots) {
    try {
      const r = await syncClaudeMdTasksSection(root);
      results.push({ projectPath: root, ...r });
    } catch { /* skip on error */ }
  }
  return results;
});

ipcMain.handle('scan-project-tasks', async (): Promise<import('../shared/types').ProjectTask[]> => {
  const results: import('../shared/types').ProjectTask[] = [];
  const projectsCfg = await loadProjectConfig();
  const coworkCfg = await loadCoworkConfig();

  const scan = async (projectPath: string, projectName: string, projectType: 'project' | 'cowork') => {
    const tasksDir = path.join(projectPath, 'tasks');
    let entries: string[];
    try { entries = await fs.promises.readdir(tasksDir); } catch { return; }
    for (const entry of entries) {
      const isBash = entry.endsWith('.sh');
      const isNode = entry.endsWith('.js');
      if (!isBash && !isNode) continue;
      const scriptPath = path.join(tasksDir, entry);
      let stat: fs.Stats;
      try { stat = await fs.promises.stat(scriptPath); } catch { continue; }
      if (!stat.isFile()) continue;
      let content = '';
      try { content = await fs.promises.readFile(scriptPath, 'utf-8'); } catch { /* fall through with empty content */ }
      const meta = parseTaskFrontmatter(content);
      results.push({
        projectPath,
        projectName,
        projectType,
        taskName: entry.replace(/\.(sh|js)$/, ''),
        scriptPath,
        language: detectTaskLanguage(entry),
        description: meta.description,
        serverHint: meta.serverHint,
        envHints: meta.envHints,
      });
    }
  };

  for (const p of projectsCfg.projects) {
    await scan(p.path, p.name, 'project');
  }
  for (const r of coworkCfg.repositories) {
    await scan(r.localPath, r.name, 'cowork');
  }
  return results;
});

ipcMain.handle('read-task-script', async (_e, scriptPath: string): Promise<{ content: string } | { error: string }> => {
  // Sanity: must end with .sh or .js and live under a known project/cowork path
  if (!scriptPath.endsWith('.sh') && !scriptPath.endsWith('.js')) return { error: 'Nur .sh- oder .js-Dateien' };
  const projectsCfg = await loadProjectConfig();
  const coworkCfg = await loadCoworkConfig();
  const allRoots = [
    ...projectsCfg.projects.map(p => p.path),
    ...coworkCfg.repositories.map(r => r.localPath),
  ];
  const resolved = path.resolve(scriptPath);
  if (!allRoots.some(root => resolved.startsWith(path.resolve(root) + path.sep))) {
    return { error: 'Pfad nicht in registriertem Projekt' };
  }
  try {
    return { content: await fs.promises.readFile(resolved, 'utf-8') };
  } catch (err) {
    return { error: (err as Error).message };
  }
});

// ─── MacMC: System Info ──────────────────────────────────────────────────────
// Cumulative net counters tracked between calls for delta calculation
let lastNetCounters: { rx: number; tx: number; ts: number } | null = null;

ipcMain.handle('get-mac-sysinfo', async (): Promise<import('../shared/types').MacSysinfo> => {
  const now = new Date().toISOString();
  const fail: import('../shared/types').MacSysinfo = {
    hostname: '', os: '', cpu: 0, cpuUser: 0, cpuSystem: 0,
    mem: { used: 0, total: 0 }, swap: { used: 0, total: 0 },
    disk: { used: 0, total: 0 }, net: { rxBytes: 0, txBytes: 0 },
    uptime: 0, loadAvg: [0, 0, 0], fetchedAt: now,
  };
  try {
    const [hostnameR, osR, topR, vmstatR, swapR, dfR, netstatR, batteryR, uptimeR, memTotalR] = await Promise.all([
      execAsync('hostname').catch(() => ({ stdout: '' })),
      execAsync('sw_vers -productVersion').catch(() => ({ stdout: '' })),
      execAsync('top -l 1 -n 0 -s 0').catch(() => ({ stdout: '' })),
      execAsync('vm_stat').catch(() => ({ stdout: '' })),
      execAsync('sysctl -n vm.swapusage').catch(() => ({ stdout: '' })),
      execAsync('df -k /').catch(() => ({ stdout: '' })),
      execAsync('netstat -ib').catch(() => ({ stdout: '' })),
      execAsync('pmset -g batt').catch(() => ({ stdout: '' })),
      execAsync('uptime').catch(() => ({ stdout: '' })),
      execAsync('sysctl -n hw.memsize').catch(() => ({ stdout: '' })),
    ]);

    const hostname = hostnameR.stdout.trim();
    const os = `macOS ${osR.stdout.trim()}`;

    // CPU usage from top: "CPU usage: 5.12% user, 3.45% sys, 91.43% idle"
    let cpuUser = 0, cpuSystem = 0;
    const cpuMatch = topR.stdout.match(/CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys/);
    if (cpuMatch) { cpuUser = parseFloat(cpuMatch[1]); cpuSystem = parseFloat(cpuMatch[2]); }
    const cpu = Math.round((cpuUser + cpuSystem) * 10) / 10;

    // RAM: vm_stat (4096-byte pages by default on modern macOS, but extract from header)
    const pageSizeMatch = vmstatR.stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;
    const memTotal = parseInt(memTotalR.stdout.trim() || '0', 10); // bytes
    const getPages = (key: string): number => {
      const re = new RegExp(`Pages ${key}[^:]*:\\s+(\\d+)`);
      const m = vmstatR.stdout.match(re);
      return m ? parseInt(m[1], 10) : 0;
    };
    const wired = getPages('wired down');
    const active = getPages('active');
    const compressed = getPages('occupied by compressor');
    const usedBytes = (wired + active + compressed) * pageSize;
    const mem = {
      used: Math.round(usedBytes / 1024 / 1024),         // MB
      total: Math.round(memTotal / 1024 / 1024),         // MB
    };

    // Swap: "total = 2048.00M used = 0.00M free = 2048.00M (encrypted)"
    let swap = { used: 0, total: 0 };
    const swapMatch = swapR.stdout.match(/total\s*=\s*([\d.]+)([KMG])\s+used\s*=\s*([\d.]+)([KMG])/);
    if (swapMatch) {
      const unit = (s: string) => s === 'G' ? 1024 : s === 'K' ? 1 / 1024 : 1;
      swap = {
        total: Math.round(parseFloat(swapMatch[1]) * unit(swapMatch[2])),
        used:  Math.round(parseFloat(swapMatch[3]) * unit(swapMatch[4])),
      };
    }

    // Disk root volume: df -k / → 1K-blocks Used Available
    let disk = { used: 0, total: 0 };
    const dfLines = dfR.stdout.trim().split('\n');
    if (dfLines.length >= 2) {
      const parts = dfLines[1].split(/\s+/);
      if (parts.length >= 4) {
        const totalKB = parseInt(parts[1], 10);
        const usedKB = parseInt(parts[2], 10);
        disk = {
          used: Math.round(usedKB / 1024 / 1024 * 10) / 10, // GB
          total: Math.round(totalKB / 1024 / 1024 * 10) / 10,
        };
      }
    }

    // Network: netstat -ib aggregate (Ibytes + Obytes per interface, excluding lo0)
    let rxBytes = 0, txBytes = 0;
    const netLines = netstatR.stdout.split('\n').slice(1);
    const seenIfs = new Set<string>();
    for (const line of netLines) {
      const parts = line.split(/\s+/);
      if (parts.length < 10) continue;
      const ifname = parts[0];
      if (!ifname || ifname.startsWith('lo') || seenIfs.has(ifname)) continue;
      seenIfs.add(ifname);
      const ibytes = parseInt(parts[6], 10);
      const obytes = parseInt(parts[9], 10);
      if (!isNaN(ibytes)) rxBytes += ibytes;
      if (!isNaN(obytes)) txBytes += obytes;
    }
    // Compute delta-per-second since last call
    let net = { rxBytes: 0, txBytes: 0 };
    const nowTs = Date.now();
    if (lastNetCounters) {
      const dt = (nowTs - lastNetCounters.ts) / 1000;
      if (dt > 0) {
        net = {
          rxBytes: Math.max(0, Math.round((rxBytes - lastNetCounters.rx) / dt)),
          txBytes: Math.max(0, Math.round((txBytes - lastNetCounters.tx) / dt)),
        };
      }
    }
    lastNetCounters = { rx: rxBytes, tx: txBytes, ts: nowTs };

    // Battery
    let battery: import('../shared/types').MacSysinfo['battery'];
    const battMatch = batteryR.stdout.match(/(\d+)%;\s*(\S+)/);
    if (battMatch) {
      battery = {
        percent: parseInt(battMatch[1], 10),
        charging: /charging|charged|AC Power/i.test(batteryR.stdout) && !/discharging/i.test(batteryR.stdout),
      };
      const remainMatch = batteryR.stdout.match(/(\d+):(\d+) remaining/);
      if (remainMatch) battery.timeRemaining = parseInt(remainMatch[1], 10) * 60 + parseInt(remainMatch[2], 10);
    }

    // Uptime + load
    let uptime = 0;
    let loadAvg: [number, number, number] = [0, 0, 0];
    const upMatch = uptimeR.stdout.match(/load averages?: ([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (upMatch) loadAvg = [parseFloat(upMatch[1]), parseFloat(upMatch[2]), parseFloat(upMatch[3])];
    try {
      const r = await execAsync('sysctl -n kern.boottime');
      const m = r.stdout.match(/sec = (\d+)/);
      if (m) uptime = Math.floor(Date.now() / 1000) - parseInt(m[1], 10);
    } catch { /* ignore */ }

    return { hostname, os, cpu, cpuUser, cpuSystem, mem, swap, disk, net, battery, uptime, loadAvg, fetchedAt: now };
  } catch (err) {
    console.error('[get-mac-sysinfo]', (err as Error).message);
    return fail;
  }
});

// ─── MacMC: Process list ─────────────────────────────────────────────────────
ipcMain.handle('get-mac-processes', async (_event, limit: number = 100): Promise<import('../shared/types').MacProcess[]> => {
  try {
    // Sort by CPU desc; columns: pid, ppid, user, %cpu, %mem, rss(KB), time, command
    const { stdout } = await execAsync('ps -Ao pid=,ppid=,user=,%cpu=,%mem=,rss=,time=,command= -r');
    const lines = stdout.split('\n').slice(0, limit);
    const procs: import('../shared/types').MacProcess[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Split on whitespace, but command is everything after the 7th column
      const parts = trimmed.split(/\s+/);
      if (parts.length < 8) continue;
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (isNaN(pid)) continue;
      const user = parts[2];
      const cpu = parseFloat(parts[3]);
      const mem = parseFloat(parts[4]);
      const rss = parseInt(parts[5], 10);
      const time = parts[6];
      const command = parts.slice(7).join(' ');
      procs.push({ pid, ppid, user, cpu, mem, rss, time, command });
    }
    return procs;
  } catch (err) {
    console.error('[get-mac-processes]', (err as Error).message);
    return [];
  }
});

ipcMain.handle('kill-mac-process', async (_event, pid: number, signal: 'TERM' | 'KILL' = 'TERM'): Promise<{ success: boolean; error?: string }> => {
  if (!Number.isInteger(pid) || pid <= 1) return { success: false, error: 'Ungültige PID' };
  try {
    await execAsync(`kill -${signal} ${pid}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

// ─── MacMC: Autostart (LaunchAgents + Login Items) ───────────────────────────
function parsePlistValue(content: string, key: string): string | null {
  // Best-effort plain-string extraction (works for typical plist format)
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = content.match(re);
  return m ? m[1] : null;
}
function parsePlistBool(content: string, key: string): boolean | null {
  const re = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
  const m = content.match(re);
  return m ? m[1] === 'true' : null;
}

async function readLaunchDir(dir: string, type: import('../shared/types').MacAutostartType): Promise<import('../shared/types').MacAutostart[]> {
  const results: import('../shared/types').MacAutostart[] = [];
  if (!fs.existsSync(dir)) return results;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.plist')); } catch { return results; }
  // Get list of loaded launchctl labels (user domain)
  let loadedLabels = new Set<string>();
  try {
    const { stdout } = await execAsync('launchctl list');
    for (const line of stdout.split('\n').slice(1)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts[2]) loadedLabels.add(parts[2]);
    }
  } catch { /* ignore */ }
  for (const f of entries) {
    const fullPath = path.join(dir, f);
    let content = '';
    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
    const label = parsePlistValue(content, 'Label') ?? f.replace(/\.plist$/, '');
    const programArg = parsePlistValue(content, 'Program');
    let program = programArg ?? undefined;
    if (!program) {
      const argMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)</);
      if (argMatch) program = argMatch[1];
    }
    const runAtLoad = parsePlistBool(content, 'RunAtLoad') ?? false;
    results.push({
      id: fullPath,
      label,
      type,
      path: fullPath,
      program,
      enabled: loadedLabels.has(label),
      runAtLoad,
    });
  }
  return results;
}

ipcMain.handle('get-mac-autostarts', async (): Promise<import('../shared/types').MacAutostart[]> => {
  const results: import('../shared/types').MacAutostart[] = [];
  const home = os.homedir();
  results.push(...await readLaunchDir(path.join(home, 'Library/LaunchAgents'), 'launch-agent-user'));
  results.push(...await readLaunchDir('/Library/LaunchAgents', 'launch-agent-system'));
  results.push(...await readLaunchDir('/Library/LaunchDaemons', 'launch-daemon'));

  // Login Items via osascript
  try {
    const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get the name of every login item'`);
    const names = stdout.trim().split(',').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      // Get path
      let appPath = '';
      try {
        const { stdout: p } = await execAsync(`osascript -e 'tell application "System Events" to get the path of login item "${name.replace(/"/g, '\\"')}"'`);
        appPath = p.trim();
      } catch { /* ignore */ }
      results.push({
        id: `login-item:${name}`,
        label: name,
        type: 'login-item',
        path: appPath || name,
        enabled: true,
        runAtLoad: true,
      });
    }
  } catch (err) {
    console.error('[get-mac-autostarts] osascript login items failed:', (err as Error).message);
  }

  // Sort: enabled first, then by type, then by label
  results.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.label.localeCompare(b.label);
  });
  return results;
});

ipcMain.handle('toggle-mac-autostart', async (_event, item: import('../shared/types').MacAutostart, enable: boolean): Promise<{ success: boolean; error?: string }> => {
  try {
    if (item.type === 'login-item') {
      if (enable) {
        const escapedPath = item.path.replace(/"/g, '\\"');
        await execAsync(`osascript -e 'tell application "System Events" to make login item at end with properties {path:"${escapedPath}", hidden:false}'`);
      } else {
        const escapedName = item.label.replace(/"/g, '\\"');
        await execAsync(`osascript -e 'tell application "System Events" to delete login item "${escapedName}"'`);
      }
      return { success: true };
    }
    // LaunchAgent / LaunchDaemon
    const action = enable ? 'load' : 'unload';
    const args = item.type === 'launch-daemon' ? `sudo launchctl ${action}` : `launchctl ${action}`;
    await execAsync(`${args} -w "${item.path}"`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

