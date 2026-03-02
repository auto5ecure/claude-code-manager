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

  // Project settings
  getProjectSettings: (projectId: string): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('get-project-settings', projectId),
  saveProjectSettings: (projectId: string, settings: object): Promise<boolean> => ipcRenderer.invoke('save-project-settings', projectId, settings),

  // Terminal PTY (multi-tab)
  ptySpawn: (tabId: string, cwd: string, runClaude?: boolean): Promise<boolean> => ipcRenderer.invoke('pty-spawn', tabId, cwd, runClaude),
  ptyWrite: (tabId: string, data: string): void => ipcRenderer.send('pty-write', tabId, data),
  ptyResize: (tabId: string, cols: number, rows: number): void => ipcRenderer.send('pty-resize', tabId, cols, rows),
  ptyKill: (tabId: string): Promise<boolean> => ipcRenderer.invoke('pty-kill', tabId),
  onPtyData: (callback: (tabId: string, data: string) => void): void => {
    ipcRenderer.on('pty-data', (_event, tabId, data) => callback(tabId, data));
  },
  onPtyExit: (callback: (tabId: string, code: number) => void): void => {
    ipcRenderer.on('pty-exit', (_event, tabId, code) => callback(tabId, code));
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

  platform: process.platform,
} as const;

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
