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

// Sub-Agent types
export type AgentState = 'pending' | 'running' | 'done' | 'error';

export interface Agent {
  id: string;
  projectPath: string;
  projectName: string;
  task: string;
  state: AgentState;
  output: string;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

// AutoMail types
export interface MailAccount {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  ssl: boolean;
  folder: string; // default: 'INBOX'
  lastChecked?: string;
  authType?: 'basic' | 'oauth2';   // default: 'basic'
  oauth2ClientId?: string;          // Azure App Registration Client ID
  oauth2TenantId?: string;          // Azure Tenant ID or 'common'
}

export interface OAuth2Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
}

export interface MailMessage {
  uid: number;
  subject: string;
  from: string;
  date: string;
  seen: boolean;
  preview: string;
}

export interface MailConnectionResult {
  success: boolean;
  greeting?: string;
  error?: string;
}

// Server Credential types (v1.1.24)
export interface ServerCredential {
  id: string;              // UUID
  name: string;            // Display name, e.g. "Prod Web Server"
  host: string;            // Hostname / IP
  port: number;            // Default: 22
  user: string;            // SSH user
  authType: 'key' | 'password' | 'both';
  sshKeyPath?: string;     // Path to private key (non-sensitive)
  hasPassphrase: boolean;  // Passphrase stored in vault?
  hasPassword: boolean;    // SSH password stored in vault?
  hasApiToken: boolean;    // API token stored in vault?
  projectIds: string[];    // Assigned project IDs (empty = global)
  notes?: string;
  createdAt: string;       // ISO date
  updatedAt: string;
}

// Todo types (v1.1.26)
export interface Todo {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  delegatedAgentId?: string;   // set when delegated to an agent
  delegatedAt?: string;        // ISO timestamp
  createdAt: string;
  completedAt?: string;
}

// MDMC – Mobile Device Management (v1.1.27)
export interface MDMCClient {
  id: string;
  name: string;
  platform: 'darwin' | 'linux' | 'windows' | 'android' | 'ios' | 'unknown';
  wgPubKey: string;        // WireGuard Public Key des Clients
  wgIp: string;            // z.B. "10.0.0.5"
  authToken: string;       // UUID, im Agent-Script eingebettet
  wgServerId: string;      // ServerCredential.id des WG-Servers
  wgInterface: string;     // z.B. "wg0"
  createdAt: string;
  notes?: string;
}

export interface ClientSysInfo {
  hostname: string;
  os: string;
  cpu: number;             // %-Auslastung (0-100)
  mem: { used: number; total: number };   // MB
  disk: Array<{ mount: string; used: number; total: number }>; // GB
  uptime: number;          // Sekunden
  battery?: number;        // % (iOS/Android)
  location?: { lat: number; lon: number; accuracy: number };
}

export interface MDMCSettings {
  wsPort: number;          // Default: 4242
  macWgIp: string;         // IP des Mac im WG-Netz
  wgServerId?: string;     // Default WG-Server
  wgInterface: string;     // Default: "wg0"
  wgSubnet: string;        // Default: "10.0.0.0/24"
  nextIpIndex: number;     // Counter für nächste Client-IP (startet bei 10)
}

// IPC channel names
export const IPC_CHANNELS = {
  GET_APP_PATH: 'get-app-path',
  READ_CONFIG: 'read-config',
  WRITE_CONFIG: 'write-config',
} as const;
