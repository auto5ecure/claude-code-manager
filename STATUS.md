# STATUS

## Current State
**v1.1.59 RELEASED** — Cowork **Force Pull** (`git reset --hard` auf Remote-Stand, verwirft lokale getrackte Änderungen + divergierende Commits, lässt untracked Dateien stehen) + 📡 **Fernbedienungs-Button** bei allen Projekten (führt `/remote-control` im Terminal aus). Signiert; Notarisierung wird mangels Apple-Creds übersprungen (signed-but-not-notarized).

## Vorherige Releases
**v1.1.37** — Selection-Farbe weiß auf dunklem Grund (CSS global + xterm-Theme)
**v1.1.36** — GitHub Account Manager + Settings Modal + Passwort-Manager mit System-Credentials

> Detail-Changelogs der v1.1.38–v1.1.58 stehen in der Git-History (`git log`).

> Hinweis: Gastown-Integration (v0.7.38–v0.7.71) wurde in v0.7.72 vollständig entfernt. Aktuelle Codebase basiert auf dem stabilen Pre-Gastown-Stand.

## Implemented Features

### Sicherheit / Credential Management (v1.1.21+)
- [x] ClaudeMC Vault: Verschlüsselte Zugangsdaten via Electron `safeStorage` + macOS Keychain
- [x] Vault-Schema: `mail:{id}:password|oauth2`, `server:{id}:password|sshPassphrase|apiToken`, `pw:{id}:password`, `gh:{id}:token`
- [x] Auto-Migration: Plaintext-Passwörter werden beim Start in den Vault verschoben
- [x] Passwort-Manager (v1.1.35) – globale verschlüsselte Einträge mit Generator
- [x] Passwort-Manager System-Credentials View (v1.1.36) – read-only Übersicht aller von Claude MC verwalteten Vault-Credentials (Mail / Server / GitHub)
- [x] GitHub Account Manager (v1.1.36) – PATs für Cowork Git-Operationen
- [x] Settings Modal (v1.1.36) – ⚙-Button in der NavSidebar

### Server / SSH (v1.1.24–v1.1.29)
- [x] Server Credential Manager – SSH-Key, Passphrase, Passwort, API-Token (verschlüsselt)
- [x] SSH-Terminal als PTY-Tab
- [x] Claude-Terminal direkt auf Server (`ssh -t … claude`)
- [x] Sysinfo Live + Cache (CPU, RAM, Disk, OS, Uptime)
- [x] Purpose-Inline-Edit
- [x] SSH-Key-Autosetup (authorized_keys)
- [x] Server-Kontext im Orchestrator
- [x] Sysinfo Auto-Fetch beim ersten Laden (v1.1.30)

### EmailMC (v1.1.2–v1.1.20)
- [x] IMAP Konten readonly (Basic + OAuth2 für O365)
- [x] OAuth2 PKCE Flow mit Auto-Refresh
- [x] Ordner-Navigation (LIST `*`)
- [x] Ollama-Integration: Zusammenfassung / Kategorie / Antwort / Extraktion (Streaming)
- [x] Smart Sort: URGENT / ACTION / RECHNUNG / FYI / NOISE (mit 30s Timeout)
- [x] Auto-Refresh alle 2 min, Unread-Badge in NavSidebar
- [x] Single-Mail-Klassifizierung (Brain-Button)
- [x] Ollama-Beenden-Button (v1.1.31)

### MDMC – Mobile Device Management (v1.1.27)
- [x] WireGuard Peer-Verwaltung (Pure-Node x25519, kein wg-CLI nötig)
- [x] WebSocket-Server (Port 4242) auf dem Mac
- [x] Remote-Terminal via PTY-Bridge (xterm ↔ WebSocket ↔ Node-Agent)
- [x] Sysinfo-Heartbeat (30s)
- [x] Client-Generator-Wizard (3 Steps): Config → Generate → Download/QR
- [x] Online-Badge in NavSidebar

### Performance / Stabilität
- [x] WebGL Terminal Renderer + Lazy Tab Init (v1.0.0)
- [x] PTY-Output Batching 8ms (v0.9.8)
- [x] Cowork Polling 30s (v0.9.7)
- [x] Footer Flex-Layout (v0.9.7)
- [x] Terminal abgeschnitten Fix (v0.9.9)
- [x] EPIPE-Crash Fix (v1.1.10)
- [x] OAuth2 login_hint Fix (v1.1.9)
- [x] Cowork Lock Edge-Cases (v1.1.8) – stale-Lock + Force-Unlock + before-quit Cleanup
- [x] Performance-Refactor (v1.1.6) – useMemo/useCallback/Refs
- [x] EmailMC Loading + Auto-Refresh + Search-Lock (v1.1.18–v1.1.20)
- [x] execSync→execAsync Migration (v1.1.23) – verhindert UI-Hang bei git/SSH/Deploy
- [x] Terminal Scroll-Bug-Fix + safeFit (v1.1.32) + Scroll-Button (v1.1.35)

### Sub-Agents + Orchestrator + Wiki (v0.9.0+)
- [x] Sub-Agents Tab (parallele `claude --print` Sessions)
- [x] Agent-Übersichtsseite mit Card-Grid (v1.1.34)
- [x] Agent-Feedback-System (v1.1.25)
- [x] Server-Dropdown im Agents-Tab
- [x] Orchestrator (Anthropic API) mit Projekt-Kontext + persistenter Selektion
- [x] Internes Wiki (`~/.claude/mc-wiki/`) – Projektseiten + Orchestrator-Logs

### Goose-Style UI Redesign (v1.1.0+)
- [x] Icon-basierte NavSidebar (lucide-react)
- [x] HomeView Dashboard
- [x] StatusBar (Footer)
- [x] Dark + Light Theme mit Custom Properties
- [x] Copyright Footer (v1.1.34)
- [x] Wiki-Nav Refresh-Buttons pro Projekt (v1.1.34)
- [x] Persönliche ToDos mit Agent-Delegation (v1.1.26)

### Core / Coworking / Deployment / Auto-Updater
- [x] Project list, Multi-Tab Terminal, CLAUDE.md Editor, Git-Integration, Cmd+K/P/L
- [x] Drag & Drop Projekt-Hinzufügen, Screenshot-Clipboard
- [x] Cowork: Pre-Flight, Lock, Force Unlock, Auto-Refresh
- [x] Deployment: SSH+Docker, Status, Logs, Rollback, Import/Export
- [x] Auto-Updater: Nextcloud WebDAV, Auto-Install (macOS+Windows), Changelog Modal
- [x] Code Signing (autosecure GmbH Z6R48744LS) + Apple Notarization

### Release-Automation (v1.1.31)
- [x] `scripts/release.sh` – Vollautomatischer Flow (bump → dist → upload → push)
- [x] `scripts/typecheck.sh` – TypeScript-Check Shortcut
- [x] `~/.claude/scripts/session-end.sh` – Session-End-Checkliste (global)
- [x] `~/.claude/scripts/md-sync.sh` – MD-Datei-Commit-Helper (global)

## Verified
- `npm run build` → PASS
- `npm run typecheck` → PASS
- `npm run dist` → PASS (signiert + notarisiert)
- Auto-Update → PASS
- Code Signing + Notarization → PASS

## Blocked
- NONE

## Degraded
- NONE

## Release Info
- **Aktuelle Version:** 1.1.59
- **Download:** https://nx65086.your-storageshare.de/s/CfccibEAdNja7tc
- **Release Notes:** release/RELEASE.md
- **Signiert von:** autosecure GmbH (Z6R48744LS)

---
Last updated: 2026-06-12
