# Claude Code Manager

Electron-basierte Desktop-Anwendung zur Verwaltung von Claude Code Projekten.

> **Hinweis zum Aufräumen:** Detail-Changelogs der einzelnen v1.1.x-Releases stehen in `CLAUDE.md.backup-*` und in der Git-History. Diese Datei beschreibt nur Architektur, Patterns und derzeit relevante Fixes.

---

## Projektstruktur

```
src/
  main/                    # Electron Main Process
    index.ts               # IPC Handler, PTY, Git, Cowork, Server, Mail, Vault-Wiring
    preload.ts             # contextBridge → Renderer-API
    vault.ts               # safeStorage-basierter Credential-Vault
    wiki-generator.ts      # Wiki-Generierung (Obsidian)
    whatsapp-service.ts    # Baileys-Integration
    cli-server.ts          # Lokaler HTTP-Server für claudemc-task CLI
    mdmc-server.ts         # WebSocket-Server für Remote-Clients
  renderer/
    components/            # React-Komponenten (pro NavView ein *Panel)
    styles/index.css       # Globale Styles + CSS Custom Properties (Theme)
    theme.ts               # Dark/Light Tokens + applyTheme()
    ThemeContext.tsx
  shared/types.ts          # Gemeinsame Interfaces (Main ↔ Renderer)

task-server/               # Standalone REST-Service (deployt auf VPS)
  src/{server,store,runner,scheduler,types}.ts
  Dockerfile + package.json

tools/claudemc-task.js     # CLI für Sub-Agents (Symlink: ~/.local/bin/claudemc-task)
scripts/                   # release.sh, typecheck.sh
release/version.json       # shareToken + writeToken für Nextcloud-Upload
```

---

## Build-Prozess

```bash
npm run build        # TypeScript kompilieren
npm run dev          # Entwicklungsmodus
npm run dist         # Electron-App paketieren (DMG + ZIP)
./scripts/release.sh                    # Vollständiger Release-Flow
./scripts/release.sh -v 1.2.0 -n "..." # Mit Version + Notes
./scripts/release.sh --dry-run          # Vorschau ohne Build/Upload
./scripts/typecheck.sh                  # TypeScript Typecheck
```

`release.sh` macht: Version bump → `npm run dist` → Nextcloud Upload (DMG, ZIP, version.json) → git commit/push. Tokens kommen aus `release/version.json` (nicht hardcoded).

Globale Helper unter `~/.claude/scripts/`:
- `session-end.sh [PROJECT_PATH]` — Session-Abschluss Checkliste
- `md-sync.sh [PROJECT_PATH]` — geänderte MDs interaktiv committen

---

## Core Patterns

### IPC Handler
```typescript
ipcMain.handle('handler-name', async (_event, arg1, arg2) => {
  return result;
});
```

### Preload Bridge
```typescript
handlerName: (arg1: T1, arg2: T2): Promise<R> => ipcRenderer.invoke('handler-name', arg1, arg2),
```

### Project ID
```typescript
const projectId = projectPath.replace(/\//g, '-');
```

### Settings-Speicherort
- `~/.claude/projects/{projectId}/settings.local.json` — Projekt-Einstellungen
- `~/.claude/projects/{projectId}/wiki-settings.json` — Wiki-Konfiguration
- `~/.claude/{projects,cowork-repositories,servers,mail-accounts,github-accounts,passwords,task-servers,todos,mdmc-*}.json` — globale Listen

### Projekt-Marker (`claudemc.md`)
Jedes registrierte Projekt erhält `claudemc.md` im Root (Projekt-ID, Name, Typ, Ursprungspfad). Ermöglicht Wiederherstellung bei Pfadänderungen. Wird nur einmal erstellt, nicht überschrieben.

### Pfad-Änderung erkennen
`get-projects` / `get-cowork-repositories` setzen `exists: boolean`. UI zeigt Warnung + "Pfad ändern"-Button (`update-project-path`, `update-cowork-path`).

---

## ClaudeMC Vault (Credential Storage)

`src/main/vault.ts` — alle Secrets verschlüsselt via Electron `safeStorage`. Plaintext-JSON ist tabu.

**Key-Schema:**
- `mail:{id}:password`, `mail:{id}:oauth2`
- `server:{id}:sshPassphrase`, `server:{id}:password`, `server:{id}:apiToken`
- `gh:{id}:token`
- `pw:{id}:password`
- `tasksrv:{id}:token`

**Helpers:** `vaultSet`, `vaultGet`, `vaultHas`, `vaultDelete`, `vaultDeletePrefix`, Konstante `VAULT_SENTINEL = '__vault__'` als Platzhalter in JSON.

**System-Credentials-View** (PasswordManagerPanel → Tab "System-Credentials"): read-only Übersicht aller `mail:`/`server:`/`gh:`-Keys mit 10s-Reveal + 30s-Clipboard-Clear. Backend-Whitelist verhindert Zugriff auf `pw:`-Keys (eigener Handler).

---

## Git Auth Flow (kritisch, v1.1.56/57)

GitHub-Operationen (Cowork fetch/pull/push, Lock-Handler) müssen den korrekten Token aus dem Vault nutzen, nicht den macOS-Keychain-Cache.

**Architektur:**
1. **GitHubAccount Modal** (Settings → GitHub Accounts) speichert PATs in Vault `gh:{id}:token`.
2. **`getGitCredentialEnv(repoUrl)`** parst Owner aus URL, sucht passenden Account, schreibt Temp-Script `/tmp/ghcred-{id}-{ts}.sh` als `GIT_ASKPASS`, gibt `{ GIT_ASKPASS, GIT_TERMINAL_PROMPT: '0' }` zurück.
3. **`GIT_NO_HELPER = '-c credential.helper= -c credential.useHttpPath=false'`** wird in `gitFetch`/`gitPull`/`gitCommitAndPush` PREPENDED wenn `env.GIT_ASKPASS` gesetzt — sonst zieht macOS-osxkeychain alte Tokens VOR dem ASKPASS.
4. **Lock-Handler** (`create/release/force-release-cowork-lock`) holen `getCoworkGitEnv(repoPath)` und übergeben `helperOverride` an git-Aufrufe.

**Auto-Login bei Auth-Fehler:** `parse-git-auth-error` regex-detected `Repository not found`/`Permission denied`/`403`/`Authentication failed`, extrahiert Owner/Repo. `GitHubAuthErrorModal` zeigt: gh-cli-Accounts (`gh auth status` parsen, `gh auth token --user X`) one-click oder manuelles Token-Feld. Auto-Retry der ursprünglichen Aktion nach Speichern. Trigger-Sites: `PreFlightModal` (via `onAuthError`-Prop), `handleCoworkPull`, `handleNotificationPull`.

`saveGitHubAccount` deduppt per Username (kein Mehrfach-Anlegen bei Retry-Clicks).

---

## Performance-Architektur (NICHT regressen)

### 1. PTY Output-Batching (8ms)
`ptyProcess.onData` buffert in `ptyDataBuffers` Map, sendet alle 8ms gebatcht via IPC. Reduziert IPC-Last beim Claude-Streaming von 500+/s auf max. ~125/s. `onExit` flusht Buffer vor `pty-exit`.

### 2. xterm.js WebGL-Renderer
`xterm-addon-webgl` — GPU-beschleunigt, entlastet WindowServer. Fallback auf Canvas via `onContextLoss → webglAddon.dispose()`. **Scrollback: 5000** (war Default 1000).

### 3. `safeFit()` statt direktem `fitAddon.fit()`
Bewahrt Scroll-Position wenn User nicht am Ende ist (Toleranz `distFromBottom <= 2` wegen Streaming-Jitter). Alle `fit()`-Calls in Terminal.tsx nutzen den Wrapper.

### 4. xterm-Viewport CSS
`.xterm-viewport` MUSS `overflow-y: scroll` haben (xterm-Default). Falscher `auto !important`-Override führte zu Scroll-Bug (Scrollbar erscheint/verschwindet → Breite ändert sich → fit-Loop).

### 5. Pattern-Check im Batch
`checkForNotificationPatterns` läuft NUR im 8ms-Timer (auf gebatchten Daten), NIEMALS pro rohem PTY-Chunk.

### 6. `await execAsync` statt `execSync`
67+ git-/ssh-/Deployment-Helpers nutzten früher blockierendes `execSync` → Main-Process-Hang während Operations. Komplett auf `util.promisify(exec)` umgestellt.

### 7. EPIPE-Schutz
```typescript
process.on('uncaughtException', (err) => {
  if ((err as any).code === 'EPIPE') return;
  console.error('[Main]', err);
});
```
Alle Streaming-Sender (`orchestrator-chunk`, `ollama-chunk`, `claude-chunk`) in try/catch — Pipe-Close beim Tab-Wechsel crasht sonst die App.

### 8. Renderer-Optimierungen (App.tsx, AgentsTab, OrchestratorTab)
- `useMemo` für gefilterte Listen, `useCallback` für Handler
- `useRef` für Polling-Intervals (kein Reset bei Repo-Änderung)
- `lastRefresh` als Ref (kein Re-Render alle 30s)
- AgentsTab `scrollIntoView` → 80ms Debounce
- OrchestratorTab `renderMarkdown` → Module-Level Map-Cache (max 200)
- Lazy Tab Init: xterm-Instanzen erst beim ersten Aktiv-Wechsel
- Agent Output-Buffer cap bei 100k chars (Memory-Leak-Prevention)

### 9. `isVisible` Prop + Double-RAF Fit
Terminal bekommt `isVisible={navView === 'terminal'}`. `useEffect([isVisible, activeTabId])` mit zwei verschachtelten `requestAnimationFrame` → Layout vor `safeFit()` gepaintet. ResizeObserver 32ms debounced.

### 10. Ollama On-Demand
`ollama-ensure-running` startet `ollama serve` detached, pollt 10s. `withOllama<T>(fn)` Wrapper in EmailMC: vor Operation start, danach `pkill ollama`. Spart RAM/CPU permanent.

---

## NavView Inventar

`NavView = 'home' | 'terminal' | 'projects' | 'cowork' | 'agents' | 'orchestrator' | 'wiki' | 'todos' | 'passwords' | 'emailmc' | 'servermc' | 'macmc' | 'mdmc' | 'rtaskmc'`

| View | Component | Datenmodell | Hauptfeatures |
|---|---|---|---|
| home | HomeView | — | Greeting, Stats, Quick Actions, Recent Log |
| terminal | Terminal | tabs[] | xterm.js + PTY pro Tab, WebGL |
| projects | ProjectsPanel | Project[] | CLAUDE.md-Editor, Path-Update, Export/Import (`v1`-JSON-Bundle) |
| cowork | CoworkPanel | CoworkRepository[] | Git-Sync (30s-Polling), Lock-Mechanismus, Export/Import |
| agents | AgentsTab | AgentEntry[] | `claude --print` Sub-Prozesse, sessionId-Resume, Feedback-Datei |
| orchestrator | OrchestratorTab | — | Anthropic-SDK-Chat (`claude-opus-4-5-20251101`), Kontext-Multi-Select persistent |
| wiki | WikiPanel | — | Markdown-Viewer, Sync aus CLAUDE.md, Refresh-Buttons pro Projekt |
| todos | TodosPanel | Todo[] | Global `~/.claude/todos.json`, Delegate→Agent |
| passwords | PasswordManagerPanel | PasswordEntry[] | Vault `pw:`, Generator, System-Credentials-View |
| emailmc | EmailMCPanel | MailAccount[] | IMAP read, OAuth2 (O365), Ollama/Claude Smart Sort (5 Kategorien + EINKAUF mit Firmen-Subfolder) |
| servermc | ServerMCPanel | ServerCredential[] | SSH-Terminal, Claude-Console, Sysinfo (CPU/RAM/Disk/Uptime), Purpose, Docker-Status, SSH-Key-Autosetup |
| macmc | MacMCPanel | — | Lokale Sysinfo (2s), Prozesse (3s), Autostart (LaunchAgents/Daemons/Login Items) |
| mdmc | MDMCPanel | MDMCClient[] | WireGuard + WebSocket :4242, Remote-Terminal, Client-Bundle-Generator |
| rtaskmc | RTaskMCPanel | TaskJob[] + TaskSchedule[] | Remote Task Server, Project-Tasks aus `tasks/*.sh`, Cron-Scheduler |

---

## Theming

`localStorage('theme')` → `dark` (default) oder `light`. `[data-theme="light"]` auf `<html>` mit CSS Custom Properties Override. **`initTheme()` MUSS vor React-Render** in `main.tsx` — sonst Flash.

Selection (markierter Text):
- Global `::selection` in `index.css` — weißer BG, dunkle Schrift im Dark
- xterm hat eigene Canvas/WebGL-Selection → `selectionBackground: '#ffffff66'` + `selectionForeground: '#18181b'` im Theme-Objekt

---

## Vault Migration (Startup)

`app.whenReady()` scant beim Start `mail-accounts.json` / `servers.json` / `github-accounts.json` / `passwords.json` und migriert Plaintext-Passwörter automatisch in den Vault, ersetzt Felder durch `VAULT_SENTINEL`.

---

## SSH-Auth Spezialfälle

`sshExecWithCreds()` in `index.ts`:
- `authType === 'password'`: bevorzugt `sshpass -e ssh` + `SSHPASS`-Env-Var. **Fallback ohne sshpass (macOS-Default):** Temp-Script `/tmp/sshpw-{id}-{ts}.sh` mit `chmod 700`, env `SSH_ASKPASS` + `DISPLAY=:0` + `SSH_ASKPASS_REQUIRE=force`. 30s-Cleanup-Timer.
- `authType === 'key'` mit Passphrase: temporäres `SSH_ASKPASS`-Script
- `authType === 'key'` ohne Passphrase: Standard `ssh -i keyPath`

**Quoting:** `sshSpawnWithStdin(args, command, ...)` spawnt `ssh ... bash -s` und schickt Script via stdin. Umgeht damit komplett das `"${command.replace(/"/g, '\\"')}"`-Problem — kritisch für Sysinfo-Script (Backslash-Escapes in JS-Backticks).

**Sysinfo-Script:** `strip(chr(34))` statt `strip('\"')` — keine Escape-Probleme im Python-Heredoc.

---

## OAuth2 (Office 365 IMAP)

**PKCE-Flow ohne Client Secret:**
1. Azure App Registration: **Single Tenant**, Redirect URI Typ "Mobile and desktop applications" → `http://localhost`
2. API Permissions: **APIs my organization uses** → "Office 365 Exchange Online" → Delegated → `IMAP.AccessAsUser.All` (NICHT Microsoft Graph!)
3. Tenant ID = "Directory (tenant) ID" aus Azure AD Overview (NICHT "common" — sonst `AADSTS50194`)
4. App muss `login_hint: account.user` in Auth-URL setzen, sonst Token für falschen Account → `NoADRecipient`

**Scopes:** `https://outlook.office365.com/IMAP.AccessAsUser.All offline_access`

**Token-Speicherort:** `~/.claude/mail-tokens/{accountId}.json`. Auto-Refresh wenn Access Token < 60s vor Ablauf. IMAP nutzt `AUTHENTICATE XOAUTH2`.

**Exchange Online IMAP-Aktivierung (Admin):**
```powershell
Set-CasMailbox -Identity "user@domain.com" -ImapEnabled $true
```

**Fehler-Cheatsheet:**
| Code | Ursache | Fix |
|---|---|---|
| `AADSTS50194` | Single-Tenant nutzt `/common` | Eigene Tenant-ID |
| `AADSTS700016` | Client ID falsch | Application (client) ID prüfen |
| `NoADRecipient` | IMAP für Mailbox deaktiviert ODER login_hint fehlt | siehe oben |
| `invalid_request` | Redirect URI fehlt | Azure → Authentication → `http://localhost` (Mobile/Desktop) |

---

## Cowork Lock-Mechanismus

Bewusst minimalistisch: Lock = `.cowork.lock`-Datei im Repo. Quelle der Wahrheit ist GitHub; lokal liegt die Datei mit, damit ClaudeMC den Lock-State kennt. **Keine** In-Memory-Map, **kein** Heartbeat, **keine** Crash-Recovery, **kein** Auto-Release beim Schließen — alles Komplexität die Bugs versteckte statt sie zu lösen.

- `check-cowork-lock`: fetcht den Lock-File vom Remote, parst, gibt `{ locked, lock, isOwnLock, age }` zurück
- `create-cowork-lock`: schreibt `.cowork.lock` → commit → push
- `release-cowork-lock`: löscht Datei → commit → push. Wenn Branch divergiert ist, schlägt der Push fehl und der User sieht den Fehler — kein automagisches Rebase.
- `force-release-cowork-lock`: stellt sicher dass `.cowork.lock` lokal vorhanden ist (notfalls per `git checkout <remote>/<branch> -- .cowork.lock`) → löscht → commit → `push --force-with-lease`. Nicht-destruktiv für lokale uncommitted Changes.

**Polling:** 30s-Intervall für Lock-Status anderer User.

**Recovery wenn ich vergessen habe zu unlocken:** ClaudeMC neu starten — die Lock-Datei ist im Repo committed, also nach Restart immer noch da. Ein Klick auf Unlock und der Lock ist weg. Kollege kann auch ohne mein Zutun via Force Unlock weiter.

**Beenden-Bestätigung:** `mainWindow.on('close')` prüft nur noch `ptyProcesses.size` → Dialog wenn > 0. Locks bleiben absichtlich liegen.

---

## Export/Import Bundles

**Projekt (`claudemcExport: 'v1'`):** name, type, description, originalPath, files.CLAUDE.md, files.claudemc.md, settings.{local,wiki}. **NICHT** Source-Code, **NICHT** Vault-Secrets.

**Cowork (`claudemcCoworkExport: 'v1'`):** repo (githubUrl, remote, branch, unleashed, wiki*), settings.{local,wiki}. Import flow: Manifest-Check → Target-Folder-Picker → `git clone {githubUrl} {parent/repo.name}` (300s timeout) → Settings schreiben → Registrierung.

Vorhandene CLAUDE.md/claudemc.md werden als `.bak-{ts}` gesichert.

---

## Sub-Agents Architektur

- `create-agent` läuft **ohne** `--no-session-persistence` → `sessionId` aus erstem stream-json Event capturen, in `AgentEntry.sessionId` ablegen
- `reply-to-agent(agentId, reply)`: `claude --print --resume <sessionId>` mit Autonomie-Prefix:
  > „Arbeite ab hier vollständig autonom — keine weiteren Rückfragen. Triff sinnvolle Annahmen, dokumentiere sie kurz im Endbericht und liefere ein vollständiges Ergebnis."
- Output-Separator: `--- Antwort --- / --- Fortsetzung ---`
- **Env-Erweiterung für claudemc-task CLI:** `CLAUDEMC_API`, `CLAUDEMC_TOKEN`, `CLAUDEMC_PROJECT_PATH`, PATH um `~/.local/bin`
- Agent-Prompt-Prefix listet verfügbare `tasks/*.sh` + Hinweis auf `claudemc-task run <name>`
- Server-Context (Host/User/KeyPath) wird als Hinweis angehängt wenn Server gewählt

**Claude CLI exit code 127 Fix:** Electron vom Finder/Dock ohne Shell-PATH. Alle `spawn(claudeStatus.path, ...)` müssen explizit `PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')` setzen.

---

## RTaskMC (Remote Task Server)

**Server (`task-server/`):** Node 20 + Fastify + better-sqlite3, läuft als Docker auf VPS, bindet auf WG-IP. Endpoints: `POST /jobs`, `GET/SSE /jobs/:id/log`, `DELETE /jobs/:id` (kill + DB + log + artifacts), `DELETE /jobs?status=done,failed,killed` (bulk), `GET /jobs/:id/artifacts(/:name)`, `GET/POST/PATCH/DELETE /schedules[/:id]`. Auth: Bearer `API_KEY`. `reconcileStartup()` markiert "running" Jobs nach Server-Neustart als `failed`.

**Schedules:** `cron-parser@^4.9.0`. Scheduler-Tick alle 30s. Schedules werden VOR Dispatch markiert (`lastRunAt + nextRunAt update`) → kein Re-Fire. SIGTERM/SIGINT stoppen sauber.

**Artifacts:** Job läuft mit `cwd=$JOB_ARTIFACT_DIR` + env `JOB_ARTIFACT_DIR=/data/artifacts/{job-id}/`. Path-Traversal-Check beim Download.

**Secrets:** `env`-Vars im POST-Body NICHT in SQLite persistiert, NICHT in API-Response. Nur Process-Env während Job läuft. Über WireGuard übertragen.

**Project-Tasks:** `scan-project-tasks` findet `tasks/*.sh` in allen Projekten + Cowork-Repos, parst Frontmatter (`# @desc:`, `# @server:`, `# @env:`). `read-task-script(absPath)` mit Path-Traversal-Check (Pfad muss unter registriertem Projekt).

**CLI-Server (`src/main/cli-server.ts`):** HTTP auf `127.0.0.1:randomPort`, Token rotiert pro App-Start, Connection-Info in `~/.claude/claudemc-cli.json` (mode 0600). Endpoints: `GET /health`, `GET /list-tasks`, `POST /run-task`, `/job-status`, `/job-log` (SSE-Passthrough). Bearer-Auth außer `/health`.

**Symlink-Install:** Bei App-Start `~/.local/bin/claudemc-task` → `<app>/tools/claudemc-task.js`. Production-Build: `app.asar.unpacked/tools/` via electron-builder `extraResources`.

**CLAUDE.md Auto-Sync:** `syncClaudeMdTasksSection(projectPath)` schreibt Skill-Sektion zwischen `<!-- AUTO-RTASKMC-START -->
## RTaskMC Skill — Remote Tasks

Dieses Projekt hat ausführbare Tasks in `tasks/*.sh`. Wenn der Nutzer sagt
"starte X als RTask" / "run X remote" / "führ den deploy-Task aus", dann nutze
das vorhandene CLI:

```bash
claudemc-task list                                 # verfügbare Tasks listen
claudemc-task run <name>                           # Job feuern (Output im RTaskMC-Tab)
claudemc-task run <name> --wait                    # feuern + live mitlesen, Exit-Code = Job-Exit
claudemc-task run <name> --env KEY=VAL             # einen Secret-Wert ins Job-Env injizieren
claudemc-task run <name> --env-file ./.env         # KEY=VAL aus Datei lesen (--env überschreibt)
claudemc-task status <jobId>                       # Status eines Jobs (one-liner)
claudemc-task log <jobId>                          # Log eines Jobs (backlog + live bis Ende)
```

**Verfügbare Tasks:**
- `disk-usage` — Disk-Usage des VPS + Container-Volumes als Report *(server: n8n VPS)*
- `env-debug` — Probe — zeigt einzelne env-Vars (nur für env-pass-through-Test) *(server: n8n VPS)*
- `hello` — Simple hello-world Demo-Task *(server: n8n VPS)*

Output erscheint im **RTaskMC-Tab** der ClaudeMC-App mit Projekt-Badge. Neue Tasks
können als `tasks/<name>.sh` angelegt werden (optional Frontmatter `# @desc:`,
`# @server:`, `# @env:`).
<!-- AUTO-RTASKMC-END -->` Markern. Trigger: App-Start, RTaskMC-↻-Button, IPC. Idempotent: ersetzt zwischen Markern; ohne Marker append; ohne CLAUDE.md create; ohne `tasks/*.sh` no-op.

**meta-Field:** `Job.meta?: { projectId, projectName, taskName, source }` — SQLite-Spalte (Migration: ADD COLUMN). RTaskMC zeigt Badge `📂 projectName · taskName`.

---

## MDMC Protokoll

```
Client→Server: hello { token, platform, hostname }  →  Server: hello-ok { clientId }
Client→Server: sysinfo { cpu, mem, disk, uptime, ... }
Server→Client: exec-pty { ptyId, cols, rows }
Client→Server: pty-data { ptyId, data (base64) }
Server→Client: pty-input { ptyId, data }
```

`mdmcPtyMap: Map<tabId, clientId>` in `index.ts`. `pty-write`/`pty-resize`-Handler routen Input via `sendToClient()` an Remote-Client. Terminal.tsx braucht **keine** Änderungen — gleiche IPC-Events.

WireGuard-Keys: `generateWireGuardKeys()` pure Node x25519, kein externer `wg`-Befehl. Peer-Add via SSH: `wg show wg0 public-key` → `wg set wg0 peer <pub> allowed-ips <ip>/32` → `tee -a /etc/wireguard/wg0.conf`.

---

## Wiki

`~/.claude/mc-wiki/projects/{projectId}.md` (aus CLAUDE.md synced), `~/.claude/mc-wiki/logs/{ts}-{title}.md` (Orchestrator-Logs). Index-Tabelle: `| Projekt | Beschreibung | Typ | Branch | Status |`. Beschreibung aus CLAUDE.md extrahiert (max 50 chars). Marker `<!-- AUTO-GENERATED-START/END -->` schützen manuelle Abschnitte. Changelog append-only. Auto-Trigger: PTY-Exit, CLAUDE.md-Save, Cowork-Commit, 🔮-Button.

---

## EmailMC: Smart Sort Provider

**Provider-Toggle** in Settings-Modal: `ollama` (default war früher) oder `claude` (Default jetzt — bessere Qualität, kein lokales RAM, Batch in einem Call).

- `claudeModel`: `haiku` | `sonnet` | `opus` (localStorage `emailmc_claude_model`)
- `runClaudeInkognito({ systemPrompt, userMessage, model, onChunk })`: spawnt `claude --print --output-format stream-json --no-session-persistence --model <m>`. Stream über `claude-chunk` IPC.
- `claude-classify-mail-batch(emails, model?)`: alle Mails in EINEM Call (Chunks zu 50). Parser sucht ersten `[...]`-Block. Unmatched UIDs → FYI.
- Privacy: `from`+`subject` (und Body bei Analyse) gehen an Anthropic-API über lokale Claude-CLI. Bei sensiblen Mailboxen Provider auf `ollama`.

**Kategorien:** `URGENT | ACTION | RECHNUNG | EINKAUF | FYI | NOISE`. EINKAUF hat Subfolder pro Firma (`extractCompanyFromAddress(from)` + `COMPANY_DOMAIN_MAP` für bekannte Shops, Root-Domain-Capitalize sonst). Ollama: 30s-Timeout pro Mail (`ollamaCollect`).

**Auto-Refresh:** 2min `setInterval`, kein Loading-Spinner, `searchQueryRef` verhindert Überschreiben aktiver Suche. Unread-Badge im NavSidebar via `onUnreadCountChange`.

---

## MacMC (Lokales Monitoring)

Pausiert via `isActive`-Prop wenn Tab nicht aktiv.

| Tab | Quelle | Intervall |
|---|---|---|
| System | `top -l 1 -n 0`, `vm_stat` + `sysctl hw.memsize`, `sysctl vm.swapusage`, `df -k /`, `netstat -ib` (Delta), `pmset -g batt`, `sysctl kern.boottime` | 2s |
| Prozesse | `ps -Ao pid,ppid,user,%cpu,%mem,rss,time,command -r` (150 top) | 3s |
| Autostart | `~/Library/LaunchAgents/`, `/Library/Launch{Agents,Daemons}/`, `osascript "login items"` | on-demand |

`lastNetCounters`-Closure für Network-Delta. Plist-Parsing via Regex (kein Library nötig). LaunchAgent-enabled: Vergleich mit `launchctl list`-Labels. Toggle: `launchctl load/unload -w` (User direkt, System/Daemon via sudo).

**Safety:** Kill-PID ≤ 1 blockiert (init). Modal-Bestätigung vor Kill.

---

## Bekannte Pitfalls

- **Schwarzes Fenster nach Tab-Schließen:** `doCloseTab` muss `setNavView('home')` setzen wenn `newTabs.length === 0`.
- **Tab-Wechsel zu bestehendem Tab:** `setActiveTabId()` PLUS `setNavView('terminal')`, sonst bleibt User im Projekte-/Cowork-Panel.
- **Offene Tabs visualisieren:** `openProjectPaths`/`openCoworkIds`/`openServerIds` als `useMemo`-Sets aus `tabs` ableiten, grüner Dot via `.tab-open-dot`.
- **Sysinfo Auto-Fetch:** `loadServers()` triggert `fetchServerSysinfo()` im Hintergrund wenn `loadServerSysinfo()` null liefert.
- **Wiki-Nav für noch-nicht-synced:** Grüner Punkt = synced, grauer = noch nicht. Klick auf grau erstellt Eintrag. `↻` pro Projekt direkt in Nav.

---

## Abhängigkeiten (Hinweise)

- `@anthropic-ai/sdk` — Orchestrator
- `lucide-react` — Icons (NavSidebar, ServerMC etc.)
- `xterm-addon-webgl@^0.16.0` — Terminal-Renderer
- `ws@^8.18.0` + `@types/ws` — MDMC WebSocket-Server
- `qrcode` — MDMC Client-Bundle
- `cron-parser@^4.9.0` — RTaskMC Scheduler (task-server)
- `better-sqlite3` + `fastify` — task-server
