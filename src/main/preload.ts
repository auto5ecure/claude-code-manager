import { contextBridge, ipcRenderer } from 'electron';

export interface Project {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  hasClaudeMd: boolean;
}

const api = {
  getAppPath: (): Promise<string> => ipcRenderer.invoke('get-app-path'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  checkClaudeCode: (): Promise<{
    installed: boolean;
    version?: string;
    path?: string;
    error?: string;
    instructions?: string;
  }> => ipcRenderer.invoke('check-claude-code'),
  getProjects: (): Promise<Project[]> => ipcRenderer.invoke('get-projects'),
  addProject: (): Promise<Project | null> => ipcRenderer.invoke('add-project'),
  addProjectByPath: (path: string): Promise<Project | null> => ipcRenderer.invoke('add-project-by-path', path),
  selectProjectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-project-folder'),
  addProjectWithType: (path: string, type: 'tools' | 'projekt'): Promise<Project | null> => ipcRenderer.invoke('add-project-with-type', path, type),
  removeProject: (path: string): Promise<boolean> => ipcRenderer.invoke('remove-project', path),
  renameProject: (path: string, name: string): Promise<boolean> => ipcRenderer.invoke('rename-project', path, name),
  setProjectType: (path: string, type: 'tools' | 'projekt'): Promise<boolean> => ipcRenderer.invoke('set-project-type', path, type),
  getTemplate: (type: 'tools' | 'projekt'): Promise<string> => ipcRenderer.invoke('get-template', type),
  getGlobalSettings: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('get-global-settings'),
  getClaudeMd: (): Promise<string> => ipcRenderer.invoke('get-claude-md'),

  // Project actions
  openInFinder: (projectPath: string): Promise<void> => ipcRenderer.invoke('open-in-finder', projectPath),
  openInTerminal: (projectPath: string): Promise<void> => ipcRenderer.invoke('open-in-terminal', projectPath),
  startClaude: (projectPath: string): Promise<void> => ipcRenderer.invoke('start-claude', projectPath),

  // Project CLAUDE.md
  getProjectClaudeMd: (projectPath: string): Promise<string | null> => ipcRenderer.invoke('get-project-claude-md', projectPath),
  saveProjectClaudeMd: (projectPath: string, content: string): Promise<boolean> => ipcRenderer.invoke('save-project-claude-md', projectPath, content),
  getProjectFiles: (projectPath: string): Promise<{
    claudeMd: { exists: boolean; size: number };
    contextMd: { exists: boolean; size: number };
    decisionsMd: { exists: boolean; size: number };
    statusMd: { exists: boolean; size: number };
    tasksDir: { exists: boolean; count: number };
  }> => ipcRenderer.invoke('get-project-files', projectPath),

  // Project settings
  getProjectSettings: (projectId: string): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('get-project-settings', projectId),
  saveProjectSettings: (projectId: string, settings: object): Promise<boolean> => ipcRenderer.invoke('save-project-settings', projectId, settings),

  // Terminal PTY (multi-tab)
  ptySpawn: (tabId: string, cwd: string, cols: number, rows: number, runClaude?: boolean, autoAccept?: boolean): Promise<boolean> => ipcRenderer.invoke('pty-spawn', tabId, cwd, cols, rows, runClaude, autoAccept),
  ptyWrite: (tabId: string, data: string): void => ipcRenderer.send('pty-write', tabId, data),
  ptyResize: (tabId: string, cols: number, rows: number): void => ipcRenderer.send('pty-resize', tabId, cols, rows),
  ptyKill: (tabId: string): Promise<boolean> => ipcRenderer.invoke('pty-kill', tabId),
  onPtyData: (callback: (tabId: string, data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string, data: string) => callback(tabId, data);
    ipcRenderer.on('pty-data', handler);
    return () => ipcRenderer.removeListener('pty-data', handler);
  },
  onPtyExit: (callback: (tabId: string, code: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string, code: number) => callback(tabId, code);
    ipcRenderer.on('pty-exit', handler);
    return () => ipcRenderer.removeListener('pty-exit', handler);
  },

  // Clipboard screenshot
  getClipboardImage: (): Promise<string | null> => ipcRenderer.invoke('get-clipboard-image'),
  saveScreenshot: (projectPath: string, dataUrl: string): Promise<string> => ipcRenderer.invoke('save-screenshot', projectPath, dataUrl),

  // Activity Log
  logEntry: (type: 'command' | 'activity' | 'error', message: string, project?: string): Promise<boolean> =>
    ipcRenderer.invoke('log-entry', type, message, project),
  getLog: (limit?: number, projectFilter?: string): Promise<Array<{
    timestamp: string;
    type: 'command' | 'activity' | 'error';
    project?: string;
    message: string;
  }>> => ipcRenderer.invoke('get-log', limit, projectFilter),
  clearLog: (): Promise<boolean> => ipcRenderer.invoke('clear-log'),

  // Cowork Repositories
  getCoworkRepositories: (): Promise<Array<{
    id: string;
    name: string;
    localPath: string;
    githubUrl: string;
    remote: string;
    branch: string;
    lastSync?: string;
    hasCLAUDEmd: boolean;
  }>> => ipcRenderer.invoke('get-cowork-repositories'),
  addCoworkRepository: (repo: {
    name: string;
    localPath: string;
    githubUrl: string;
    remote: string;
    branch: string;
    lastSync?: string;
  }): Promise<{ success: boolean; error?: string; repository?: object }> =>
    ipcRenderer.invoke('add-cowork-repository', repo),
  removeCoworkRepository: (repoId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('remove-cowork-repository', repoId),
  getCoworkSyncStatus: (localPath: string, remote: string, branch: string): Promise<{
    state: 'synced' | 'behind' | 'ahead' | 'diverged' | 'conflict';
    ahead: number;
    behind: number;
    hasUncommittedChanges: boolean;
    changedFiles: string[];
    error?: string;
  }> => ipcRenderer.invoke('get-cowork-sync-status', localPath, remote, branch),
  coworkPull: (localPath: string, remote: string, branch: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cowork-pull', localPath, remote, branch),
  coworkCommitPush: (localPath: string, message: string, remote: string, branch: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cowork-commit-push', localPath, message, remote, branch),
  updateCoworkLastSync: (repoId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-cowork-last-sync', repoId),
  createCoworkClaudeMd: (localPath: string, content: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('create-cowork-claude-md', localPath, content),
  getCoworkReposDir: (): Promise<string> =>
    ipcRenderer.invoke('get-cowork-repos-dir'),
  validateCoworkRepository: (githubUrl: string, localPath?: string): Promise<{
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
  }> => ipcRenderer.invoke('validate-cowork-repository', githubUrl, localPath),
  cloneCoworkRepository: (githubUrl: string, targetPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('clone-cowork-repository', githubUrl, targetPath),
  checkCoworkLock: (repoPath: string): Promise<{
    locked: boolean;
    lock?: { user: string; machine: string; timestamp: string };
    isStale?: boolean;
    isOwnLock?: boolean;
    age?: number;
  }> => ipcRenderer.invoke('check-cowork-lock', repoPath),
  createCoworkLock: (repoPath: string, remote: string, branch: string): Promise<{ success: boolean; error?: string; lock?: object }> =>
    ipcRenderer.invoke('create-cowork-lock', repoPath, remote, branch),
  releaseCoworkLock: (repoPath: string, remote: string, branch: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('release-cowork-lock', repoPath, remote, branch),
  forceReleaseCoworkLock: (repoPath: string, remote: string, branch: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('force-release-cowork-lock', repoPath, remote, branch),

  // Deployment APIs
  getDeploymentConfigs: (): Promise<import('../shared/types').DeploymentConfig[]> =>
    ipcRenderer.invoke('get-deployment-configs'),
  addDeploymentConfig: (config: Omit<import('../shared/types').DeploymentConfig, 'id'>): Promise<{ success: boolean; config?: import('../shared/types').DeploymentConfig; error?: string }> =>
    ipcRenderer.invoke('add-deployment-config', config),
  removeDeploymentConfig: (configId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('remove-deployment-config', configId),
  getDeploymentStatus: (config: import('../shared/types').DeploymentConfig): Promise<import('../shared/types').DeploymentStatus> =>
    ipcRenderer.invoke('get-deployment-status', config),
  getDeploymentLogs: (config: import('../shared/types').DeploymentConfig, lines?: number): Promise<{ success: boolean; logs?: string; error?: string }> =>
    ipcRenderer.invoke('get-deployment-logs', config, lines),
  runDeployment: (config: import('../shared/types').DeploymentConfig): Promise<import('../shared/types').DeploymentResult> =>
    ipcRenderer.invoke('run-deployment', config),
  deploymentRollback: (config: import('../shared/types').DeploymentConfig): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('deployment-rollback', config),
  testSshConnection: (host: string, user: string, sshKeyPath?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('test-ssh-connection', host, user, sshKeyPath),
  onDeploymentProgress: (callback: (data: { steps: import('../shared/types').DeploymentStep[] }) => void): (() => void) => {
    const handler = (_event: unknown, data: { steps: import('../shared/types').DeploymentStep[] }) => callback(data);
    ipcRenderer.on('deployment-progress', handler);
    return () => ipcRenderer.removeListener('deployment-progress', handler);
  },
  importDeploymentConfigs: (): Promise<{ success: boolean; imported: number; error?: string }> =>
    ipcRenderer.invoke('import-deployment-configs'),
  exportDeploymentConfigs: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('export-deployment-configs'),
  exportCoworkRepositories: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('export-cowork-repositories'),
  importCoworkRepositories: (): Promise<{ success: boolean; imported: number; error?: string }> =>
    ipcRenderer.invoke('import-cowork-repositories'),

  // Auto-Updater
  checkForUpdates: (): Promise<{ available: boolean; latestVersion?: string; error?: string }> =>
    ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (onProgress?: (progress: number) => void): Promise<{ success: boolean; error?: string }> => {
    if (onProgress) {
      const handler = (_event: unknown, progress: number) => onProgress(progress);
      ipcRenderer.on('update-progress', handler);
    }
    return ipcRenderer.invoke('download-update');
  },

  platform: process.platform,
} as const;

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
