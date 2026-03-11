# SYSTEM CONTEXT

## System Overview
- Desktop application for managing Claude Code configurations
- Electron-based (Node.js main process + Chromium renderer)
- Manages multiple Claude Code project configurations
- Provides GUI for settings, MCP servers, permissions
- **Coworking-Feature**: Team collaboration on shared GitHub repositories

## Architecture Snapshot
- **Core services**: Electron main process with IPC bridge
- **Infrastructure**: Local filesystem, Electron store
- **Data flow**: Renderer ↔ IPC ↔ Main ↔ Filesystem
- **External dependencies**: Claude Code CLI (reads/writes its config), Git

## Key Features

### Project Management
- Add/remove projects with type selection (Tools/Projekt)
- CLAUDE.md template system per project type
- Integrated terminal with Claude Code auto-start
- Project settings (auto-accept mode)

### Coworking System
- Shared GitHub repository management
- **Pre-Flight Check**: Pull, sync status, lock check before sessions
- **Lock System**: `.cowork.lock` file prevents concurrent editing
- **Auto-Refresh**: Status check every 5 minutes
- **Notifications**: Alert when repos have new commits
- **Commit Modal**: Push changes after sessions
- **Tab-Close Hook**: Automatic lock release when terminal tab is closed
  - Detects uncommitted changes
  - Shows commit modal (Commit/Discard/Later)
  - Releases lock after commit or discard
  - "Later" keeps lock active for manual commit

### Deployment System (integriert in Cowork)
- **Projekt-interne Config**: `.deployment.json` im Projekt-Root
- **In Cowork integriert**: Deployment-Buttons erscheinen direkt bei Cowork-Repos
- **One-Click Deployment**: Deploy via SSH mit Docker Build
- **Deployment Steps**: Git check → Server check → Backup → Transfer → Build → Deploy → Health check
- **Server Status**: Real-time Container-Status und Health-Monitoring
- **Logs Viewer**: Container-Logs direkt in der App
- **Import/Export**: Deployment-Configs können als JSON exportiert/importiert werden

### Deployment Config Format (`.deployment.json`)
```json
{
  "name": "Production",
  "projectPath": "/path/to/project",
  "server": {
    "host": "server-ip",
    "user": "root",
    "sshKeyPath": "~/.ssh/id_ed25519",
    "directory": "/opt/app"
  },
  "urls": {
    "production": "https://example.com",
    "health": "/health"
  },
  "docker": {
    "imageName": "app",
    "dockerfile": "Dockerfile",
    "containerName": "app-web"
  }
}
```

### Cowork Lock File Format
```json
{
  "user": "username",
  "machine": "hostname",
  "timestamp": "ISO-8601",
  "pid": 12345
}
```

## File Structure
```
src/
├── main/
│   ├── index.ts      # Electron main, IPC handlers, Git/SSH helpers
│   └── preload.ts    # API bridge to renderer
├── renderer/
│   ├── components/
│   │   ├── App.tsx              # Main app state
│   │   ├── Sidebar.tsx          # Project + Cowork lists
│   │   ├── Terminal.tsx         # PTY terminal tabs
│   │   ├── CoworkSection.tsx    # Cowork repos + Deployment integration
│   │   ├── AddCoworkRepoModal.tsx
│   │   ├── PreFlightModal.tsx   # Lock + sync check
│   │   ├── CommitModal.tsx      # Post-session commit
│   │   ├── CoworkNotification.tsx
│   │   ├── DeploymentModal.tsx      # Deployment progress
│   │   └── DeploymentLogsModal.tsx  # Container logs viewer
│   └── styles/
│       └── index.css
└── shared/
    └── types.ts      # CoworkRepository, SyncStatus, DeploymentConfig
```

## Data Storage
- **Projects**: `{userData}/projects.json`
- **Cowork Repos**: `{userData}/cowork-repositories.json`
- **Cloned Repos**: `{userData}/repos/{repo-name}`
- **Deployment Configs**: `{projectPath}/.deployment.json` (pro Projekt)
- **Activity Log**: `{userData}/activity.log`

## Build & Delivery
- **Build targets**: macOS (arm64, x64), Windows, Linux
- **CI/CD**: TBD
- **Artifacts**: .dmg, .exe, .AppImage
- **Release strategy**: Semantic versioning

## Constraints
- **Technical**: Must not interfere with running Claude Code sessions
- **Security**: No network calls except Git operations
- **Performance**: Fast startup (<2s), low memory footprint

## Active Risks
1. Claude Code config format may change without notice
2. File permission issues on different OS
3. Git merge conflicts in coworking scenarios

## Definition of Done
- Can read/write Claude Code configurations
- Cross-platform builds pass
- No data loss on config operations
- Cowork lock system prevents concurrent editing

## References
- Electron docs → https://electronjs.org/docs
- Claude Code config → ~/.claude/
