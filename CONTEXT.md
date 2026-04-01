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
- **Force Unlock** (ab v0.4.6): Immer sichtbar wenn Lock existiert
- **Auto-Refresh**: Status check every 5 minutes
- **Notifications**: Alert when repos have new commits
- **Commit Modal**: Push changes after sessions
- **Tab-Close Hook**: Automatic lock release when terminal tab is closed
  - Detects uncommitted changes
  - Shows commit modal (Commit/Discard/Later)
  - Releases lock after commit or discard
  - "Later" keeps lock active for manual commit

### Deployment System (integriert in Cowork)
- **Projekt-interne Config**: `.deployment.json` im Projekt-Root (lokal, nicht in Git)
- **In Cowork integriert**: Deployment-Buttons erscheinen direkt bei Cowork-Repos
- **Deployment einrichten** (ab v0.4.7): Button erscheint wenn keine Config existiert
- **One-Click Deployment**: Deploy via SSH mit Docker Build
- **Deployment Steps**: Git check → Server check → Backup → Transfer → Build → Deploy → Health check
- **Server Status**: Real-time Container-Status und Health-Monitoring
- **Logs Viewer**: Container-Logs direkt in der App
- **Import/Export** (ab v0.4.9): Pro-Projekt Import/Export im Settings Modal
- **Settings Modal**: Bearbeiten der Deployment-Config direkt in der App
- **SSH-Key Auto-Discovery** (ab v0.2.7): Findet automatisch verfügbare SSH-Keys
- **SSH-Key Import** (ab v0.2.8): Private Keys per Button (+) importieren
- **Docker Warning Filter** (ab v0.4.8): DEPRECATED-Warnungen werden ignoriert

### Auto-Updater
- **Version Check**: Automatische Prüfung beim App-Start
- **Nextcloud WebDAV**: Updates via Nextcloud Public Share
- **Auto-Install macOS** (ab v0.2.4): Vollautomatische Installation
  1. DMG wird heruntergeladen
  2. DMG wird automatisch gemountet
  3. App wird nach `/Applications` kopiert
  4. DMG wird ausgeworfen
  5. App wird automatisch neu gestartet
- **Auto-Install Windows** (ab v0.4.5): Vollautomatische Installation
  1. NSIS Installer wird heruntergeladen
  2. Silent Install (`/S` Flag) wird ausgeführt
  3. App startet automatisch neu
- **Version Display**: Aktuelle Version im Footer angezeigt
- **Update Server**: `release/version.json` enthält Versions-Info und Download-URLs

### Wiki Integration (ab v0.7.4)
- **Obsidian Vault Detection**: Automatische Erkennung via `.obsidian` Ordner
- **Projekt-Level Wiki**: `WIKI.md` oder `Wiki/README.md` pro Projekt
- **Vault-Level Index**: `Wiki/Projekte/_index.md` mit Wikilinks
- **Changelog**: Session-Änderungen werden protokolliert
- **Auto-Trigger**: Bei PTY Exit, CLAUDE.md Save, Git Commit
- **Marker-System**: `<!-- AUTO-GENERATED-START/END -->` schützt manuelle Abschnitte

### Code Signing (ab v0.3.5)
- **Developer ID**: Signiert von autosecure GmbH (Z6R48744LS)
- **Notarization**: Apple-verifiziert, kein Gatekeeper-Warnung
- **Hardened Runtime**: Mit JIT und unsigned memory Entitlements für Electron
- **Build Directory**: /tmp statt release/ (Resource Fork Workaround)
- **Entitlements**: build/entitlements.mac.plist

### Settings System
- **Cowork Settings Modal**: Zentrales Zahnrad-Icon (⚙) für Import/Export
  - Cowork Repositories Import/Export
  - Deployment Configs Import/Export
- **Deployment Settings Modal**: Bearbeiten der Deployment-Konfiguration pro Projekt

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

### Auto-Update Version Format (`release/version.json`)
```json
{
  "version": "0.7.4",
  "releaseDate": "2026-04-01",
  "dmgUrl": "https://nx65086.your-storageshare.de/public.php/webdav/Claude%20MC-0.7.4-arm64.dmg",
  "zipUrl": "https://nx65086.your-storageshare.de/public.php/webdav/Claude%20MC-0.7.4-arm64-mac.zip",
  "shareToken": "CfccibEAdNja7tc",
  "notes": "Obsidian Wiki Integration: Automatische Projekt-Dokumentation"
}
```

## File Structure
```
src/
├── main/
│   ├── index.ts      # Electron main, IPC handlers, Git/SSH, Auto-Updater
│   └── preload.ts    # API bridge to renderer
├── renderer/
│   ├── components/
│   │   ├── App.tsx                    # Main app state, Update-UI
│   │   ├── Sidebar.tsx                # Project + Cowork lists
│   │   ├── Terminal.tsx               # PTY terminal tabs
│   │   ├── CoworkSection.tsx          # Cowork repos + Deployment integration
│   │   ├── AddCoworkRepoModal.tsx
│   │   ├── PreFlightModal.tsx         # Lock + sync check
│   │   ├── CommitModal.tsx            # Post-session commit
│   │   ├── CoworkNotification.tsx
│   │   ├── CoworkSettingsModal.tsx    # Import/Export Settings
│   │   ├── ChangelogModal.tsx         # Was ist neu nach Updates
│   │   ├── DeploymentModal.tsx        # Deployment progress
│   │   ├── DeploymentSettingsModal.tsx # Deployment config editor
│   │   └── DeploymentLogsModal.tsx    # Container logs viewer
│   └── styles/
│       └── index.css
├── release/
│   └── version.json  # Auto-Updater version info
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
- **Build targets**: macOS (arm64), Windows (x64)
- **CI/CD**: TBD
- **Artifacts**: .dmg (macOS), .exe NSIS Installer (Windows)
- **Release strategy**: Semantic versioning
- **Code Signing**: Developer ID Application (autosecure GmbH)
- **Notarization**: Apple notarytool via electron-builder
- **Auto-Update**: Nextcloud WebDAV Public Share
  - Read URL: `https://nx65086.your-storageshare.de/s/CfccibEAdNja7tc`
  - Write URL: `https://nx65086.your-storageshare.de/s/WzD2S5XzqwGDz3B`
  - WebDAV API: `https://nx65086.your-storageshare.de/public.php/webdav/`
  - Auth: Basic Auth mit Share-Token als Username, leeres Passwort

## Release Process

### macOS Release
1. **Version inkrementieren** in `package.json`
2. **DMG bauen** (signiert + notarisiert):
   ```bash
   APPLE_ID="it@autosecure.net" \
   APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
   npm run dist
   ```
3. **DMG hochladen** zu Nextcloud:
   ```bash
   curl -X PUT -u "WzD2S5XzqwGDz3B:" \
     --data-binary @"/tmp/claude-mc-release/Claude MC-X.Y.Z-arm64.dmg" \
     "https://nx65086.your-storageshare.de/public.php/webdav/Claude%20MC-X.Y.Z-arm64.dmg"
   ```

### Windows Release
1. **Windows Build** (cross-compile von macOS):
   ```bash
   npm run build && npx electron-builder --win --x64 -c.directories.output=/tmp/claude-mc-release
   ```
2. **EXE hochladen** zu Nextcloud:
   ```bash
   curl -X PUT -u "WzD2S5XzqwGDz3B:" \
     --data-binary @"/tmp/claude-mc-release/Claude MC Setup X.Y.Z.exe" \
     "https://nx65086.your-storageshare.de/public.php/webdav/Claude-MC-X.Y.Z-Setup.exe"
   ```

### Finalisierung
1. **version.json aktualisieren** mit `dmgUrl` und `exeUrl`
2. **version.json hochladen**:
   ```bash
   curl -X PUT -u "WzD2S5XzqwGDz3B:" \
     --data-binary @"/tmp/version.json" \
     "https://nx65086.your-storageshare.de/public.php/webdav/version.json"
   ```
3. **Verifizieren**: Auto-Updater prüft `version.json` beim App-Start

## Constraints
- **Technical**: Must not interfere with running Claude Code sessions
- **Security**: Network calls only for Git operations und Auto-Updates
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
