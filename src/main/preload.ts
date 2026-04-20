import { contextBridge, ipcRenderer } from 'electron';

export interface Project {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  hasClaudeMd: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  type: 'tools' | 'projekt';
  exists?: boolean;
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
  checkMissingProjects: (): Promise<Array<{ path: string; name: string }>> =>
    ipcRenderer.invoke('check-missing-projects'),
  scanMovedProjects: (searchPaths: string[]): Promise<{
    found: Array<{ oldPath: string; newPath: string; name: string }>;
    repaired: number;
  }> => ipcRenderer.invoke('scan-moved-projects', searchPaths),
  addProject: (): Promise<Project | null> => ipcRenderer.invoke('add-project'),
  addProjectByPath: (path: string): Promise<Project | null> => ipcRenderer.invoke('add-project-by-path', path),
  selectProjectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-project-folder'),
  addProjectWithType: (path: string, type: 'tools' | 'projekt'): Promise<Project | null> => ipcRenderer.invoke('add-project-with-type', path, type),
  removeProject: (path: string): Promise<boolean> => ipcRenderer.invoke('remove-project', path),
  renameProject: (path: string, name: string): Promise<boolean> => ipcRenderer.invoke('rename-project', path, name),
  updateProjectPath: (oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('update-project-path', oldPath, newPath),
  selectNewProjectPath: (): Promise<string | null> => ipcRenderer.invoke('select-new-project-path'),
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
  onFocusTab: (callback: (tabId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string) => callback(tabId);
    ipcRenderer.on('focus-tab', handler);
    return () => ipcRenderer.removeListener('focus-tab', handler);
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
    unleashed?: boolean;
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
  updateCoworkPath: (repoId: string, newPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('update-cowork-path', repoId, newPath),
  getCoworkSyncStatus: (localPath: string, remote: string, branch: string): Promise<{
    state: 'synced' | 'behind' | 'ahead' | 'diverged' | 'conflict';
    ahead: number;
    behind: number;
    hasUncommittedChanges: boolean;
    changedFiles: string[];
    conflictFiles?: string[];
    error?: string;
  }> => ipcRenderer.invoke('get-cowork-sync-status', localPath, remote, branch),
  coworkPull: (localPath: string, remote: string, branch: string): Promise<{
    success: boolean;
    error?: string;
    conflicts?: Array<{ file: string; localContent: string; remoteContent: string }>;
  }> => ipcRenderer.invoke('cowork-pull', localPath, remote, branch),
  coworkCommitPush: (localPath: string, message: string, remote: string, branch: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cowork-commit-push', localPath, message, remote, branch),
  updateCoworkLastSync: (repoId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-cowork-last-sync', repoId),
  updateCoworkRepoUnleashed: (repoId: string, unleashed: boolean): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-cowork-repo-unleashed', repoId, unleashed),
  createCoworkClaudeMd: (localPath: string, content: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('create-cowork-claude-md', localPath, content),
  getCoworkReposDir: (): Promise<string> =>
    ipcRenderer.invoke('get-cowork-repos-dir'),
  getConflictDetails: (repoPath: string): Promise<{
    success: boolean;
    conflicts: Array<{ file: string; localContent: string; remoteContent: string }>;
    error?: string;
  }> => ipcRenderer.invoke('get-conflict-details', repoPath),
  resolveConflict: (repoPath: string, filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('resolve-conflict', repoPath, filePath, content),
  openInEditor: (filePath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('open-in-editor', filePath),
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
  checkCoworkLock: (repoPath: string, remote?: string, branch?: string): Promise<{
    locked: boolean;
    lock?: { user: string; machine: string; timestamp: string };
    isStale?: boolean;
    isOwnLock?: boolean;
    age?: number;
  }> => ipcRenderer.invoke('check-cowork-lock', repoPath, remote, branch),
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
  importSshKey: (): Promise<{ success: boolean; keyPath?: string; error?: string }> =>
    ipcRenderer.invoke('import-ssh-key'),
  saveSshKey: (keyContent: string, keyName: string): Promise<{ success: boolean; keyPath?: string; error?: string }> =>
    ipcRenderer.invoke('save-ssh-key', keyContent, keyName),
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

  // File dialogs
  showOpenDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<{ filePaths: string[] }> =>
    ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<{ filePath?: string }> =>
    ipcRenderer.invoke('show-save-dialog', options),
  readFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('write-file', filePath, content),

  // WhatsApp Integration
  whatsappInit: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('whatsapp-init'),
  whatsappStatus: (): Promise<{
    connected: boolean;
    ready: boolean;
    phoneNumber?: string;
    error?: string;
  }> => ipcRenderer.invoke('whatsapp-status'),
  whatsappGetConfig: (): Promise<{
    enabled: boolean;
    allowedNumbers: string[];
    notifyNumbers: string[];
    autoReply: boolean;
  }> => ipcRenderer.invoke('whatsapp-get-config'),
  whatsappSaveConfig: (config: {
    enabled?: boolean;
    allowedNumbers?: string[];
    notifyNumbers?: string[];
    autoReply?: boolean;
  }): Promise<{ success: boolean }> => ipcRenderer.invoke('whatsapp-save-config', config),
  whatsappSend: (to: string, message: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('whatsapp-send', to, message),
  whatsappDisconnect: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('whatsapp-disconnect'),
  whatsappLogout: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('whatsapp-logout'),
  whatsappStartClaudeSession: (senderNumber: string, projectPath: string): Promise<{ success: boolean; tabId?: string }> =>
    ipcRenderer.invoke('whatsapp-start-claude-session', senderNumber, projectPath),
  onWhatsappQR: (callback: (qrDataUrl: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, qrDataUrl: string) => callback(qrDataUrl);
    ipcRenderer.on('whatsapp-qr', handler);
    return () => ipcRenderer.removeListener('whatsapp-qr', handler);
  },
  onWhatsappStatus: (callback: (status: { connected: boolean; ready: boolean; phoneNumber?: string; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { connected: boolean; ready: boolean; phoneNumber?: string; error?: string }) => callback(status);
    ipcRenderer.on('whatsapp-status', handler);
    return () => ipcRenderer.removeListener('whatsapp-status', handler);
  },
  onWhatsappMessage: (callback: (data: { from: string; body: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { from: string; body: string }) => callback(data);
    ipcRenderer.on('whatsapp-message', handler);
    return () => ipcRenderer.removeListener('whatsapp-message', handler);
  },
  onWhatsappLog: (callback: (data: { message: string; data?: unknown; timestamp: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string; data?: unknown; timestamp: string }) => callback(data);
    ipcRenderer.on('whatsapp-log', handler);
    return () => ipcRenderer.removeListener('whatsapp-log', handler);
  },
  whatsappCheckPermissions: (): Promise<{
    chromeInstalled: boolean;
    chromePath?: string;
    canLaunchChrome: boolean;
    permissionError?: string;
    platform: string;
  }> => ipcRenderer.invoke('whatsapp-check-permissions'),

  // Wiki Integration
  getWikiSettings: (projectId: string): Promise<{
    wikiProjectEnabled?: boolean;
    wikiVaultIndexEnabled?: boolean;
    vaultPath?: string;
    // Legacy fields for backwards compatibility
    enabled?: boolean;
    createVaultPage?: boolean;
    autoUpdateVaultIndex?: boolean;
    lastUpdated?: string;
  } | null> => ipcRenderer.invoke('get-wiki-settings', projectId),
  saveWikiSettings: (projectId: string, settings: {
    wikiProjectEnabled: boolean;
    wikiVaultIndexEnabled: boolean;
    vaultPath?: string;
  }): Promise<boolean> => ipcRenderer.invoke('save-wiki-settings', projectId, settings),
  detectVaultPath: (projectPath: string): Promise<string | null> =>
    ipcRenderer.invoke('detect-vault-path', projectPath),
  updateProjectWiki: (projectPath: string, projectId: string): Promise<{
    success: boolean;
    message?: string;
    projectWikiPath?: string;
    vaultWikiPath?: string;
    error?: string;
  }> => ipcRenderer.invoke('update-project-wiki', projectPath, projectId),
  regenerateVaultIndex: (vaultPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('regenerate-vault-index', vaultPath),
  updateCoworkWiki: (repoId: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('update-cowork-wiki', repoId),
  getCoworkWikiSettings: (repoId: string): Promise<{ enabled: boolean; vaultPath: string | null }> =>
    ipcRenderer.invoke('get-cowork-wiki-settings', repoId),
  saveCoworkWikiSettings: (repoId: string, settings: {
    wikiVaultPath: string | null;
    wikiProjectEnabled: boolean;
    wikiVaultIndexEnabled: boolean;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('save-cowork-wiki-settings', repoId, settings),

  // Utility
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('open-external', url),

  // Orchestrator
  getOrchestratorKey: (): Promise<string | null> =>
    ipcRenderer.invoke('get-orchestrator-key'),
  saveOrchestratorKey: (key: string): Promise<void> =>
    ipcRenderer.invoke('save-orchestrator-key', key),
  getProjectContexts: (paths: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('get-project-contexts', paths),
  orchestratorChat: (messages: Array<{ role: 'user' | 'assistant'; content: string }>, projectPaths: string[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('orchestrator-chat', messages, projectPaths),
  saveOrchestratorLog: (title: string, content: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('save-orchestrator-log', title, content),
  onOrchestratorChunk: (cb: (chunk: string | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: string | null) => cb(chunk);
    ipcRenderer.on('orchestrator-chunk', handler);
    return () => ipcRenderer.removeListener('orchestrator-chunk', handler);
  },

  // Sub-Agents
  createAgent: (agentId: string, projectPath: string, task: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('create-agent', agentId, projectPath, task),
  stopAgent: (agentId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('stop-agent', agentId),
  listAgents: (): Promise<import('../shared/types').Agent[]> =>
    ipcRenderer.invoke('list-agents'),
  clearAgent: (agentId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('clear-agent', agentId),
  clearAllAgents: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('clear-all-agents'),
  saveAgentFeedback: (agentId: string, projectPath: string, task: string, output: string, feedback: string): Promise<{ success: boolean; path: string; error?: string }> =>
    ipcRenderer.invoke('save-agent-feedback', agentId, projectPath, task, output, feedback),
  onAgentChunk: (cb: (data: { agentId: string; text?: string; done?: boolean; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; text?: string; done?: boolean; error?: string }) => cb(data);
    ipcRenderer.on('agent-chunk', handler);
    return () => ipcRenderer.removeListener('agent-chunk', handler);
  },
  onAgentListUpdated: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('agent-list-updated', handler);
    return () => ipcRenderer.removeListener('agent-list-updated', handler);
  },

  // Persistent Memory
  memoryGet: (): Promise<{ success: boolean; content: string | null; error?: string }> =>
    ipcRenderer.invoke('memory-get'),
  memorySave: (content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('memory-save', content),
  memoryUpdate: (messages: { role: string; content: string }[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('memory-update', messages),
  onMemoryUpdated: (cb: (content: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, content: string) => cb(content);
    ipcRenderer.on('memory-updated', handler);
    return () => ipcRenderer.removeListener('memory-updated', handler);
  },

  // Internal Wiki
  wikiGetPage: (pagePath: string): Promise<{ success: boolean; content: string | null; error?: string }> =>
    ipcRenderer.invoke('wiki-get-page', pagePath),
  wikiSavePage: (pagePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('wiki-save-page', pagePath, content),
  wikiListPages: (): Promise<{ success: boolean; projects: Array<{ name: string; path: string; mtime: number }>; logs: Array<{ name: string; path: string; mtime: number }>; error?: string }> =>
    ipcRenderer.invoke('wiki-list-pages'),
  wikiSyncProject: (projectPath: string, projectId: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('wiki-sync-project', projectPath, projectId),

  // EmailMC / Mail
  getMailAccounts: (): Promise<import('../shared/types').MailAccount[]> =>
    ipcRenderer.invoke('get-mail-accounts'),
  saveMailAccount: (account: import('../shared/types').MailAccount): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('save-mail-account', account),
  removeMailAccount: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('remove-mail-account', id),
  testMailConnection: (account: import('../shared/types').MailAccount): Promise<import('../shared/types').MailConnectionResult> =>
    ipcRenderer.invoke('test-mail-connection', account),
  fetchMailMessages: (account: import('../shared/types').MailAccount, limit?: number): Promise<{ success: boolean; messages?: import('../shared/types').MailMessage[]; total?: number; error?: string }> =>
    ipcRenderer.invoke('fetch-mail-messages', account, limit),
  fetchMailBody: (account: import('../shared/types').MailAccount, seqNum: number): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('fetch-mail-body', account, seqNum),
  listMailFolders: (account: import('../shared/types').MailAccount): Promise<{ success: boolean; folders?: string[]; error?: string }> =>
    ipcRenderer.invoke('list-mail-folders', account),

  // OAuth2
  startOAuth2: (account: import('../shared/types').MailAccount): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('oauth2-authorize', account),
  getOAuth2Status: (accountId: string): Promise<{ authorized: boolean; expiresAt?: number }> =>
    ipcRenderer.invoke('oauth2-get-status', accountId),
  revokeOAuth2: (accountId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('oauth2-revoke', accountId),
  onOAuth2Complete: (cb: (data: { accountId: string; success: boolean; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { accountId: string; success: boolean; error?: string }) => cb(data);
    ipcRenderer.on('oauth2-complete', handler);
    return () => ipcRenderer.removeListener('oauth2-complete', handler);
  },

  // Ollama
  ollamaListModels: (ollamaUrl: string): Promise<{ success: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke('ollama-list-models', ollamaUrl),
  ollamaAnalyze: (ollamaUrl: string, model: string, systemPrompt: string, userMessage: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ollama-analyze', ollamaUrl, model, systemPrompt, userMessage),
  onOllamaChunk: (cb: (data: { text?: string; done?: boolean; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text?: string; done?: boolean; error?: string }) => cb(data);
    ipcRenderer.on('ollama-chunk', handler);
    return () => ipcRenderer.removeListener('ollama-chunk', handler);
  },
  classifyMail: (ollamaUrl: string, model: string, emails: Array<{ uid: number; from: string; subject: string }>): Promise<{ uid: number; category: string }[]> =>
    ipcRenderer.invoke('ollama-classify-mail', ollamaUrl, model, emails),
  onClassifyMailProgress: (cb: (data: { done: number; total: number; uid: number; category: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { done: number; total: number; uid: number; category: string }) => cb(data);
    ipcRenderer.on('classify-mail-progress', handler);
    return () => ipcRenderer.removeListener('classify-mail-progress', handler);
  },

  // ServerMC
  getServerDockerStatus: (host: string, user: string, sshKeyPath?: string): Promise<{ success: boolean; containers?: { name: string; status: string; ports: string; image: string }[]; error?: string }> =>
    ipcRenderer.invoke('get-server-docker-status', host, user, sshKeyPath),

  // Server Credential Manager (v1.1.24)
  getServers: (projectId?: string): Promise<import('../shared/types').ServerCredential[]> =>
    ipcRenderer.invoke('get-servers', projectId),
  saveServer: (server: Partial<import('../shared/types').ServerCredential>, secrets: { sshPassphrase?: string; password?: string; apiToken?: string }): Promise<import('../shared/types').ServerCredential> =>
    ipcRenderer.invoke('save-server', server, secrets),
  removeServer: (serverId: string): Promise<void> =>
    ipcRenderer.invoke('remove-server', serverId),
  testServerConnection: (serverId: string): Promise<{ success: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('test-server-connection', serverId),
  sshOpenTerminal: (serverId: string): Promise<{ tabId: string; serverName: string; error?: string }> =>
    ipcRenderer.invoke('ssh-open-terminal', serverId),
  sshClaudeTerminal: (serverId: string): Promise<{ tabId: string; serverName: string; error?: string }> =>
    ipcRenderer.invoke('ssh-claude-terminal', serverId),
  claudeServerSession: (serverId: string, unleashed: boolean): Promise<{ tabId: string; serverName: string; sessionDir: string; error?: string }> =>
    ipcRenderer.invoke('claude-server-session', serverId, unleashed),
  serverExec: (serverId: string, command: string): Promise<{ success: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('server-exec', serverId, command),

  // Server Intelligence (v1.1.29)
  fetchServerSysinfo: (serverId: string): Promise<import('../shared/types').ServerSysinfo | { error: string }> =>
    ipcRenderer.invoke('fetch-server-sysinfo', serverId),
  loadServerSysinfo: (serverId: string): Promise<import('../shared/types').ServerSysinfo | null> =>
    ipcRenderer.invoke('load-server-sysinfo', serverId),
  setupSshKey: (serverId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('setup-ssh-key', serverId),
  saveServerPurpose: (serverId: string, purpose: string): Promise<void> =>
    ipcRenderer.invoke('save-server-purpose', serverId, purpose),

  // Todos (v1.1.26)
  getTodos: (): Promise<import('../shared/types').Todo[]> =>
    ipcRenderer.invoke('get-todos'),
  addTodo: (t: { title: string; description?: string }): Promise<import('../shared/types').Todo> =>
    ipcRenderer.invoke('add-todo', t),
  updateTodo: (id: string, updates: Partial<import('../shared/types').Todo>): Promise<import('../shared/types').Todo> =>
    ipcRenderer.invoke('update-todo', id, updates),
  deleteTodo: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('delete-todo', id),
  onTodosUpdated: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('todos-updated', handler);
    return () => ipcRenderer.removeListener('todos-updated', handler);
  },

  platform: process.platform,
} as const;

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
