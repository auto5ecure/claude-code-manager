# Claude MC

Desktop application for managing Claude Code projects with integrated terminal, coworking features, deployment system, and auto-updates.

**Code-signiert und notarisiert von autosecure GmbH** - App öffnet ohne Gatekeeper-Warnung.

## Download

**[Download Latest Release (v0.3.5)](https://nx65086.your-storageshare.de/s/CfccibEAdNja7tc)**

## Features

### Project Management
- Add, remove, and organize Claude Code projects
- Project types: "Tools" and "Projekt" workflows
- CLAUDE.md Editor for project-specific instructions
- Git integration (branch, dirty status)
- Drag & Drop project adding

### Embedded Terminal
- Multi-tab terminal with xterm.js and node-pty
- Auto-start Claude Code with initial prompt
- Auto-accept mode support

### Coworking System
- Shared GitHub repository management
- Pre-Flight Check: Pull, sync status, lock check
- Lock-System: `.cowork.lock` prevents concurrent editing
- Auto-Refresh: Status check every 5 minutes
- Commit Modal: Push changes after sessions
- Import/Export Cowork repositories

### Deployment System
- Project-internal config: `.deployment.json`
- One-Click Deployment via SSH with Docker Build
- Server Status: Real-time container monitoring
- Logs Viewer: Container logs in the app
- Rollback support
- Import/Export deployment configs
- SSH-Key Auto-Discovery and Import

### Auto-Updater
- Automatic update check on app start
- Asks before installing (no interruption of running sessions)
- Fully automatic installation on macOS
- Version display in footer

### Code Signing (v0.3.5+)
- Developer ID Application Certificate
- Apple Notarization
- App opens without security warnings

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+1-9 | Select project by number |
| Cmd+K | Focus search |
| Cmd+P | Quick commands |
| Cmd+L | Activity log |
| Escape | Close modals |

## Development

```bash
npm install
npm run dev          # Start Vite dev server
npm run dev:main     # Watch & compile main process
npm run start        # Launch Electron
```

## Build

```bash
npm run build        # Build for production
npm run dist         # Create distributable DMG (signed + notarized)
```

**Note:** Code signing requires:
- Developer ID Application certificate in Keychain
- `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` environment variables

## Release Process

1. Update version in `package.json`
2. Run `APPLE_ID="..." APPLE_APP_SPECIFIC_PASSWORD="..." npm run dist`
3. Upload DMG to Nextcloud
4. Update `release/version.json`
5. Upload version.json to Nextcloud

See `release/RELEASE.md` for detailed release notes.

## Configuration

Templates are stored in the app's user data directory:
- macOS: `~/Library/Application Support/claude-mc/templates/`
- Windows: `%APPDATA%/claude-mc/templates/`
- Linux: `~/.config/claude-mc/templates/`

Deployment configs: `.deployment.json` in project root

## System Requirements

- macOS 10.12+ (Apple Silicon)
- Node.js for Claude Code CLI

## License

MIT
