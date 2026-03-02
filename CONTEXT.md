# SYSTEM CONTEXT

## System Overview
- Desktop application for managing Claude Code configurations
- Electron-based (Node.js main process + Chromium renderer)
- Manages multiple Claude Code project configurations
- Provides GUI for settings, MCP servers, permissions

## Architecture Snapshot
- **Core services**: Electron main process with IPC bridge
- **Infrastructure**: Local filesystem, Electron store
- **Data flow**: Renderer ↔ IPC ↔ Main ↔ Filesystem
- **External dependencies**: Claude Code CLI (reads/writes its config)

## Build & Delivery
- **Build targets**: macOS (arm64, x64), Windows, Linux
- **CI/CD**: TBD
- **Artifacts**: .dmg, .exe, .AppImage
- **Release strategy**: Semantic versioning

## Constraints
- **Technical**: Must not interfere with running Claude Code sessions
- **Security**: No network calls except auto-update check
- **Performance**: Fast startup (<2s), low memory footprint

## Active Risks
1. Claude Code config format may change without notice
2. File permission issues on different OS

## Definition of Done
- Can read/write Claude Code configurations
- Cross-platform builds pass
- No data loss on config operations

## References
- Electron docs → https://electronjs.org/docs
- Claude Code config → ~/.claude/
