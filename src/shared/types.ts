// Shared type definitions between main and renderer

export interface ClaudeConfig {
  mcpServers?: Record<string, MCPServerConfig>;
  permissions?: PermissionConfig;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

// Coworking types
export interface CoworkRepository {
  id: string;
  name: string;
  localPath: string;
  githubUrl: string;
  remote: string;      // 'origin', 'autosecure'
  branch: string;      // 'main'
  lastSync?: string;
  hasCLAUDEmd: boolean;
  unleashed?: boolean; // --dangerously-skip-permissions
  wikiEnabled?: boolean;           // Legacy - kept for backwards compatibility
  wikiVaultPath?: string;          // Path to obsidian vault
  wikiProjectEnabled?: boolean;    // Update individual project wiki page
  wikiVaultIndexEnabled?: boolean; // Update vault index with this project's entry
}

export interface SyncStatus {
  state: 'synced' | 'behind' | 'ahead' | 'diverged' | 'conflict';
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  changedFiles: string[];
  conflictFiles?: string[];
}

export interface MergeConflict {
  file: string;
  localContent: string;
  remoteContent: string;
}

// Deployment types
export interface DeploymentConfig {
  id: string;
  name: string;
  projectPath: string;         // Local project path
  server: {
    host: string;              // "46.224.52.87"
    user: string;              // "root"
    sshKeyPath?: string;       // "~/.ssh/dgk_deploy"
    directory: string;         // "/opt/dgk"
  };
  urls: {
    production: string;        // "https://dgk2.autosecure.org"
    health: string;            // "/health"
  };
  docker: {
    imageName: string;         // "dgk-web"
    dockerfile: string;        // "GateAdminWeb/Dockerfile"
    containerName: string;     // "dgk-web"
  };
}

export interface DeploymentStatus {
  isOnline: boolean;
  currentVersion?: string;
  lastDeployment?: string;
  containers: ContainerInfo[];
  error?: string;
}

export interface ContainerInfo {
  name: string;
  status: string;
  uptime: string;
  ports: string;
}

export interface DeploymentStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error';
  message?: string;
}

export interface DeploymentResult {
  success: boolean;
  version?: string;
  duration: number;
  steps: DeploymentStep[];
  error?: string;
}

// Wiki Integration types
export interface WikiSettings {
  enabled?: boolean;              // Legacy - kept for backwards compatibility
  vaultPath?: string;
  projectWikiFormat?: 'folder' | 'file';
  changelogEnabled?: boolean;
  fileTrackingEnabled?: boolean;
  createVaultPage?: boolean;      // Legacy - use wikiProjectEnabled
  autoUpdateVaultIndex?: boolean; // Legacy - use wikiVaultIndexEnabled
  wikiProjectEnabled?: boolean;   // Update individual project wiki page
  wikiVaultIndexEnabled?: boolean; // Update vault index with this project's entry
  lastUpdated?: string;
}

export interface WikiUpdateResult {
  success: boolean;
  projectWikiPath?: string;
  vaultWikiPath?: string;
  changelogEntry?: string;
  error?: string;
}

// IPC channel names
export const IPC_CHANNELS = {
  GET_APP_PATH: 'get-app-path',
  READ_CONFIG: 'read-config',
  WRITE_CONFIG: 'write-config',
} as const;
