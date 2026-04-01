# STATUS

## Current State
**v0.7.4 RELEASED** — Obsidian Wiki Integration

## Implemented Features

### Core
- [x] Project list with add/remove
- [x] Embedded multi-tab terminal (xterm.js + node-pty)
- [x] Project type system (Tools/Projekt)
- [x] Type switching with progress modal
- [x] CLAUDE.md editor
- [x] Git status integration
- [x] Project search (Cmd+K)
- [x] Quick commands (Cmd+P)
- [x] Activity log (Cmd+L)
- [x] Drag & drop project adding
- [x] Screenshot clipboard support

### Coworking System
- [x] Shared GitHub repository management
- [x] Pre-Flight Check (Pull, Sync, Lock)
- [x] Lock-System (.cowork.lock)
- [x] Force Unlock immer sichtbar (ab v0.4.6)
- [x] Konflikt-Anzeige im Pre-Flight Check (ab v0.4.5)
- [x] Auto-Refresh (5 min)
- [x] Commit Modal
- [x] Tab-Close Hook mit Lock-Release
- [x] Import/Export Cowork-Repositories
- [x] CoworkSettingsModal (Zahnrad-Icon)

### Deployment System
- [x] Projekt-interne Config (.deployment.json)
- [x] One-Click Deployment via SSH + Docker
- [x] Server Status + Container Info
- [x] Logs Viewer
- [x] Rollback-Funktion
- [x] Import/Export Deployment-Configs (global)
- [x] Import/Export im Settings Modal pro Projekt (ab v0.4.9)
- [x] DeploymentSettingsModal
- [x] "Deployment einrichten" Button (ab v0.4.7)
- [x] SSH-Key Auto-Discovery (ab v0.2.7)
- [x] SSH-Key Import Button (ab v0.2.8)
- [x] Docker Build Timeout 5 Min (ab v0.3.4)
- [x] Docker DEPRECATED Warning Filter (ab v0.4.8)

### Auto-Updater
- [x] Version-Check beim App-Start
- [x] Nextcloud WebDAV Integration
- [x] Auto-Install auf macOS (ab v0.2.4)
- [x] Auto-Install auf Windows (ab v0.4.5)
- [x] Version Display im Footer
- [x] Changelog Modal (ab v0.2.6)
- [x] Update fragt vor Installation (ab v0.2.8)

### Code Signing (ab v0.3.5)
- [x] Developer ID Application Certificate
- [x] Apple Notarization
- [x] Hardened Runtime
- [x] App öffnet ohne Gatekeeper-Warnung

## Verified
- `npm run build` → PASS
- `npm run dist` → PASS (signiert + notarisiert)
- Auto-Update → PASS
- Auto-Install → PASS
- Code Signing → PASS
- Notarization → PASS

## Blocked
- NONE

## Degraded
- NONE

## Release Info
- **Aktuelle Version:** 0.7.4
- **Download:** https://nx65086.your-storageshare.de/s/CfccibEAdNja7tc
- **Release Notes:** release/RELEASE.md
- **Signiert von:** autosecure GmbH (Z6R48744LS)

---
Last updated: 2026-04-01
