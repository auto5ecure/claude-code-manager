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

// IPC channel names
export const IPC_CHANNELS = {
  GET_APP_PATH: 'get-app-path',
  READ_CONFIG: 'read-config',
  WRITE_CONFIG: 'write-config',
} as const;
