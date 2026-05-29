# Claude Code Manager

Electron-basierte Desktop-Anwendung zur Verwaltung von Claude Code Projekten.

## GitHub Auth Auto-Login (v1.1.56)

Bei git-Auth-Fehler (`Repository not found`, `Permission denied`, `403`, `Authentication failed`) öffnet sich automatisch ein **GitHubAuthErrorModal**:
- 🔒 "Zugriff fehlt auf owner/repo" — Owner aus Fehler-URL extrahiert
- Passende `gh`-Accounts werden top-priorisiert (one-click "Aus gh übernehmen")
- Andere `gh`-Konten als zweite Option
- Manuelles Token-Eingabefeld als Fallback
- Nach Speichern: automatischer Retry der ursprünglichen Aktion

**IPC:**
- `gh-cli-list-accounts` → parsed `gh auth status`
- `gh-cli-get-token(username)` → ruft `gh auth token --user X`
- `parse-git-auth-error(msg)` → Regex-Detection + Owner/Repo-Extraction

**Auto-Trigger-Sites:** PreFlightModal (via `onAuthError`-Prop), `handleCoworkPull`, `handleNotificationPull`.

**Geänderte Dateien:** `src/main/index.ts`, `src/main/preload.ts`, `src/renderer/components/GitHubAuthErrorModal.tsx` (NEU), `PreFlightModal.tsx`, `App.tsx`, `index.css` (`.gh-auth-*` Styles).

---

## RTaskMC: Retry + Cron-Scheduler (Phase 6)

**Retry-Button (🔁)** pro Job: postet einen neuen Job mit identischem Script/Name/Meta, `source='retry'`. Erscheint sofort in der Liste, ist auswählbar.

**Cron-Button (⏰)** pro Job → Modal mit Cron-Expression + Presets (stündlich/täglich/Mo–Fr 09:00 etc). Server speichert in neuer `schedules`-Tabelle, eigener Scheduler-Tick alle 30s prüft fällige Schedules und dispatched sie als reguläre Jobs mit `meta.source='schedule:<scheduleId>'`.

**Schedules-Ansicht:** Über der Job-Liste, wenn Schedules existieren. Pro Schedule: Name + Cron-Expression + nächste Ausführungszeit, ⏸ Pause / ▶ Resume Toggle, ✕ Löschen.

**Server (`task-server/`):**
- Neue Datei `src/scheduler.ts` — `ScheduleStore` (eigene Connection zum SQLite-WAL), `createSchedule()`, `startScheduler()`, `computeNextRun()`, `validateCron()`
- Endpoints: `GET/POST /schedules`, `GET/PATCH/DELETE /schedules/:id`
- Dep: `cron-parser@^4.9.0` zur Expression-Parserei
- SIGTERM/SIGINT stoppen den Scheduler sauber

**Sicherheit:**
- Cron-Expression wird validiert (cron-parser parsen → wirft bei ungültig)
- Schedules werden vor Dispatch markiert (`lastRunAt + nextRunAt update`) → kein Re-Fire wenn Dispatch langsam ist
- Beim Re-Enable wird `nextRunAt` neu berechnet → kein sofortiges Feuern wegen alter Timestamp

**Client:**
- `src/shared/types.ts` — `TaskSchedule` Interface
- 4 neue IPC Handler (`task-server-list/create/update/delete-schedule`)
- 4 neue Preload-Bridges
- `RTaskMCPanel` — Schedules-State, Action-Buttons pro Job, `ScheduleModal` mit Presets

**Geänderte Dateien:**
- `task-server/src/types.ts`, `src/scheduler.ts` (NEU), `src/server.ts`, `package.json`
- `src/main/index.ts`, `src/main/preload.ts`, `src/shared/types.ts`
- `src/renderer/components/RTaskMCPanel.tsx`, `src/renderer/styles/index.css`

---

## RTaskMC: Job-Cleanup + CLI Status/Log (Phase 5)

**Cleanup:** Server `DELETE /jobs/:id` löscht jetzt komplett (kill + DB-Row + log-Datei + artifacts-Dir). Optional `?keep=1` für nur-kill. Bulk-Cleanup via `DELETE /jobs?status=done,failed,killed`. In RTaskMC: ✕ Button pro Job (Hover) und "🗑 Erledigte" im Jobs-Header.

**CLI / Local-API Status+Log:** Der Sub-Agent / CLI-Nutzer kann jetzt auch prüfen ob ein Job durchgelaufen ist (Phase 3 hatte nur `run`):
- `claudemc-task run <name> --wait` — feuert + streamt Live-Log + Exit-Code matched Job
- `claudemc-task status <jobId>` — Status-One-Liner
- `claudemc-task log <jobId>` — Backlog + Live bis Ende

`cli-server.ts` bekam Proxy-Endpoints `/job-status` und `/job-log` — die nutzen den Vault-Token intern, exposen ihn aber nie an die CLI. Ein Agent kann damit eigenständig `run --wait` fahren und auf den exit-code reagieren.

**Geänderte Dateien:**
- `task-server/src/store.ts` — `delete(id)`, `deleteByStatus(statuses)`
- `task-server/src/server.ts` — DELETE-Endpoints (single + bulk), `?keep=1`-Flag
- `src/main/index.ts` — `task-server-delete-job(s-bulk)` IPC + erweiterte cli-server-Handler
- `src/main/cli-server.ts` — `/job-status` + `/job-log` Endpoints (SSE-Passthrough)
- `src/main/preload.ts` — `taskServerDeleteJob`, `taskServerDeleteJobsBulk` Bridges
- `src/renderer/components/RTaskMCPanel.tsx` — `handleDeleteJob`, `handleDeleteFinishedJobs`, ✕ Buttons, Bulk-Button
- `src/renderer/styles/index.css` — `.tasks-jobs-header`, `.tasks-bulk-clear-btn`, `.tasks-job-delete-btn`
- `tools/claudemc-task.js` — `status`, `log` Commands, funktionales `--wait`

---

## RTaskMC: Skill in CLAUDE.md auto-injizieren (Phase 4)

Damit der Skill **in jedem Claude-Kontext** verfügbar ist (Terminal-Claude, Sub-Agent, Orchestrator) — nicht nur in expliziten Sub-Agent-Prompts — wird in jedes Projekt mit `tasks/*.sh` eine Sektion in `CLAUDE.md` zwischen Marker-Kommentaren geschrieben:

```
<!-- AUTO-RTASKMC-START -->
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
- `hello` — Simple hello-world Demo-Task *(server: n8n VPS)*

Output erscheint im **RTaskMC-Tab** der ClaudeMC-App mit Projekt-Badge. Neue Tasks
können als `tasks/<name>.sh` angelegt werden (optional Frontmatter `# @desc:`,
`# @server:`, `# @env:`).
<!-- AUTO-RTASKMC-END -->
```

Wenn der Nutzer im Chat sagt "starte hello als RTask", liest Claude diese Sektion und ruft `claudemc-task run hello` via Bash auf. Die CLI hat im PATH und die env vars (`CLAUDEMC_API`, `CLAUDEMC_TOKEN`, `CLAUDEMC_PROJECT_PATH`) sind sowohl im **Sub-Agent** als auch im **Terminal-PTY** gesetzt.

### Trigger der Sync
- App-Start: für alle registrierten Projects + Cowork-Repos
- RTaskMC ↻-Button: alle Projekte werden re-synced
- IPC `sync-claudemd-tasks-section(projectPath)` für gezielten Re-Sync

### Marker-Idempotenz
- Existierende Sektion zwischen Markern wird ersetzt
- Wenn keine Marker vorhanden: Sektion wird ans Ende von CLAUDE.md angehängt
- Wenn keine CLAUDE.md: wird neu erzeugt
- Wenn keine tasks/*.sh: keine Aktion (Sektion bleibt unverändert oder fehlt einfach)

### Geänderte Dateien
- `src/main/index.ts` — `syncClaudeMdTasksSection()`, IPC Handlers, App-Start-Sync, PTY-env-Erweiterung
- `src/main/preload.ts` — `syncClaudemdTasksSection`, `syncAllClaudemdTasksSections` Bridges
- `src/renderer/components/RTaskMCPanel.tsx` — ↻ ruft erst sync, dann scan

---

## RTaskMC: Settings + Single-Server-Modell (Phase 3.5)

Task-Server wird ab v1.1.53 in den **allgemeinen Einstellungen** (⚙) verwaltet, nicht mehr in der RTaskMC-Sidebar. RTaskMC nimmt automatisch den ersten konfigurierten Server. UI ist auf 3 Spalten geschrumpft (Tasks | Jobs | Detail).

**Geänderte Dateien:**
- `src/renderer/components/SettingsModal.tsx` — Task-Server-Section
- `src/renderer/components/RTaskMCPanel.tsx` — Server-Spalte entfernt, Auto-Select erster Server, Server-Name im Header
- `src/renderer/styles/index.css` — `.rtaskmc-layout` von 4 auf 3 Spalten

---

## RTaskMC: Tasks als Sub-Agent-Skill (Phase 3)

Sub-Agents bekommen jetzt automatisch Zugang zu den `tasks/*.sh` ihres Projekts. Im Agent-Prompt wird ein Skill-Header eingespielt, der dem Agent sagt: "Du kannst diese Tasks via `claudemc-task run <name>` triggern." Output landet im RTaskMC-Tab mit Projekt-Badge.

### Architektur
```
Sub-Agent (claude --print)            ↓ CLAUDEMC_API + CLAUDEMC_TOKEN
  │   PATH enthält ~/.local/bin
  │
  └── claudemc-task run hello         ← User/Agent ruft die CLI auf
        │
        └── POST http://127.0.0.1:PORT/run-task   ← Lokaler HTTP-Server (cli-server.ts)
              │
              └── ClaudeMC: liest tasks/hello.sh, sucht @server-Hint, holt Vault-Token,
                  POSTet an Task-Server mit meta { projectId, projectName, taskName, source }
                    │
                    └── Job läuft auf VPS, Output in RTaskMC mit "📂 projectName · hello" Badge
```

### Komponenten

**`src/main/cli-server.ts`** (NEU)
- HTTP-Server auf `127.0.0.1:randomPort` (Kernel wählt freien Port)
- Token = 32 random bytes, rotiert bei jedem App-Start
- Connection-Info in `~/.claude/claudemc-cli.json` (mode 0600)
- Endpoints: `GET /health`, `GET /list-tasks?projectPath=...`, `POST /run-task`
- Bearer-Token-Auth (außer `/health`)

**`tools/claudemc-task.js`** (NEU)
- Zero-dependency Node-CLI
- Commands: `list`, `run <name>`
- Liest Connection-Info aus env (`CLAUDEMC_API`/`CLAUDEMC_TOKEN`) oder `~/.claude/claudemc-cli.json`
- Resolved Projekt-Pfad aus `CLAUDEMC_PROJECT_PATH` env oder cwd (aufwärts bis `tasks/` oder `.git`)

**Symlink-Install:** Bei App-Start wird `~/.local/bin/claudemc-task` → `<app>/tools/claudemc-task.js` symlinked. Im Production-Build liegt das CLI unter `app.asar.unpacked/tools/`. electron-builder `extraResources` packed es mit.

**Sub-Agent-Enrichment (`create-agent` Handler):**
- env enthält `CLAUDEMC_API`, `CLAUDEMC_TOKEN`, `CLAUDEMC_PROJECT_PATH`
- PATH erweitert um `~/.local/bin`
- Prompt-Prefix: Liste aller verfügbaren Tasks + Hinweis auf `claudemc-task run <name>`

**Task-Server `meta`-Feld:**
- `Job.meta?: { projectId, projectName, taskName, source }`
- SQLite-Spalte `meta TEXT` (Migration: ADD COLUMN wenn nicht da)
- Wird in POST /jobs akzeptiert, in GET /jobs/:id zurückgegeben
- RTaskMC-Job-Liste zeigt Badge: `📂 claude-code-manager · hello`

### Manueller Test
```bash
# Aus einem Projekt-Ordner mit tasks/*.sh:
claudemc-task list                    # zeigt Tasks
claudemc-task run hello               # startet, gibt Job-ID zurück
# → in RTaskMC mit Projekt-Badge sichtbar
```

### Geänderte Dateien
- `task-server/src/types.ts` — `JobMeta` Interface
- `task-server/src/store.ts` — `meta` Spalte + Migration
- `task-server/src/runner.ts` — `meta` an Job durchreichen
- `src/shared/types.ts` — `TaskJobMeta`, `TaskJob.meta`
- `src/main/cli-server.ts` — NEU (lokaler HTTP-Server)
- `src/main/index.ts` — CLI-Server bei whenReady starten, Symlink-Install, Sub-Agent env+prompt
- `src/main/preload.ts` — `taskServerCreateJob` Body-Type erweitert
- `src/renderer/components/RTaskMCPanel.tsx` — meta beim handleRun mitschicken, Badge anzeigen
- `src/renderer/styles/index.css` — `.tasks-job-badge*` Styles
- `tools/claudemc-task.js` — NEU (Node CLI)
- `package.json` — `extraResources` für `tools/claudemc-task.js`

---

## RTaskMC — Projekt-gebundene Tasks (Phase 2)

NavTab in `tasks` → `rtaskmc` umbenannt, Komponente `TasksPanel.tsx` → `RTaskMCPanel.tsx`. UI ist jetzt 4-spaltig: Server | Projekt-Tasks/Ad-hoc | Jobs | Detail.

**Tasks im Projekt:** Jedes registrierte Projekt + Cowork-Repo wird nach `tasks/*.sh` gescannt. Pro Script optional Frontmatter:
```bash
#!/bin/bash
# @desc: Was tut der Task (zeigt RTaskMC unter dem Task-Namen)
# @server: n8n VPS                    # Task-Server-Name, wird auto-selektiert
# @env: DB_PASS,API_KEY               # Informational (Phase-3: aus Vault auflösen)
set -euo pipefail
...
```

Klick auf einen Task → ClaudeMC lädt den Inhalt (via `read-task-script`, Path-Check innerhalb registrierter Roots), füllt das Script-Feld, wählt den `@server`-Hint automatisch, und du klickst nur noch ▶ Job starten.

**Tab-Toggle "Projekt-Tasks" vs "Ad-hoc":**
- *Projekt-Tasks*: gruppiert nach Projekt (P/C-Badge für Project/Cowork), expandiert per Klick
- *Ad-hoc*: leeres Script-Feld wie vorher, für Einmal-Sachen

**Neuer IPC:**
- `scan-project-tasks` → `ProjectTask[]` (alle Projekte + Cowork-Repos, parsed Frontmatter)
- `read-task-script(absPath)` → `{ content }`, mit Path-Traversal-Check (Pfad muss unter einem registrierten Projekt liegen)

**Geänderte Dateien:**
- `src/shared/types.ts` — `ProjectTask` Interface
- `src/main/index.ts` — `scan-project-tasks` + `read-task-script` Handler + `parseTaskFrontmatter()`
- `src/main/preload.ts` — `scanProjectTasks`, `readTaskScript` Bridges
- `src/renderer/components/RTaskMCPanel.tsx` — vorher TasksPanel.tsx; 4-Spalten-Layout, Projekt-Gruppen mit Expand-Toggle, Source-Tabs
- `src/renderer/components/NavSidebar.tsx` — `'rtaskmc'` NavView, Label "RTaskMC"
- `src/renderer/components/App.tsx` — Import + Render
- `src/renderer/styles/index.css` — `.rtaskmc-*` Styles
- `tasks/hello.sh`, `tasks/disk-usage.sh` — Demo-Tasks im eigenen Repo

---

## Task-Server (Phase 1 MVP)

Kleiner REST-Service (`task-server/`) der auf einem VPS läuft und Shell-Scripte als Hintergrund-Jobs ausführt. ClaudeMC steuert ihn per HTTP (idealerweise über VPN, z.B. WireGuard) und streamt Output via SSE in den neuen "Tasks"-Tab.

### Architektur
```
ClaudeMC (Mac)  ──HTTP/SSE──>  task-server (Docker im VPS, hört auf WG-IP)
                                  │
                                  └─ spawnt `bash -c <script>` → SQLite + log files
```

### Server (`task-server/`)
- **Stack**: Node 20 + Fastify + better-sqlite3, ~250 LoC
- **Endpoints**:
  - `GET  /health` — keine Auth
  - `POST /jobs` `{ script, env?, name? }` — Job anlegen + sofort starten
  - `GET  /jobs` — letzte 100
  - `GET  /jobs/:id`
  - `GET  /jobs/:id/log` — SSE-Stream (Backlog + Live), `event: end` zum Schluss
  - `DELETE /jobs/:id` — SIGTERM → 3s → SIGKILL
- **Auth**: Bearer-Token via `API_KEY` env var
- **Storage**: `/data/jobs.sqlite` + `/data/logs/{id}.log`
- **Deploy**: `docker run -d -p 10.0.0.2:4243:4243 -v claudemc-task-data:/data -e API_KEY=$(openssl rand -hex 32) claudemc-task-server`
- **Crash-Resilience**: `reconcileStartup()` markiert "running" Jobs nach Server-Neustart als `failed` (Process ist tot)

### Client (ClaudeMC)
- **Neuer Tab "Tasks"** in NavSidebar (PlayCircle-Icon, nach Agents)
- **TasksPanel.tsx** (3-Spalten-Layout):
  - Links: Task-Server-Liste mit Add/Edit/Remove/Test
  - Mitte: Job-Liste vom selektierten Server (5s-Polling)
  - Rechts: Neuer-Job-Form (Name + Script-Textarea + Run-Button) ODER Job-Detail mit Live-Log
- **Datenmodell** (`shared/types.ts`):
  - `TaskServerConnection { id, name, baseUrl, hasToken, ... }` — gespeichert in `~/.claude/task-servers.json`
  - `TaskJob { id, script, status, exitCode, ... }`
- **Vault-Key**: `tasksrv:{id}:token` (Bearer-Token im macOS Keychain)
- **Live-Log-Stream**: Main-Process pipet SSE-Events vom Server via `task-job-log-chunk` IPC zum Renderer. Pro Job wird eine `streamId` getrackt, damit mehrere Jobs parallel streamen können.

### IPC Handler (`src/main/index.ts`)
- `get-task-servers`, `save-task-server`, `remove-task-server`, `test-task-server`
- `task-server-list-jobs`, `task-server-create-job`, `task-server-get-job`, `task-server-kill-job`
- `task-server-stream-log`, `task-server-stop-stream`
- HTTP-Helper `taskServerRequest()` mit Bearer-Auth + Timeout, returns `{ __status, __body }` bei non-2xx

### Sicherheit
- Container bindet nur auf WG-Interface-IP (kein Public-Port)
- Bearer-Token als 2. Verteidigungslinie (defense in depth)
- Container läuft als unprivileged `node`-User
- Scripte laufen via `bash -c` — keine Sandbox; nur Scripte ausführen die du auch in Production schreiben würdest

### Artifacts (Job → Mac)
- Job läuft mit `cwd=$JOB_ARTIFACT_DIR` und env `JOB_ARTIFACT_DIR=/data/artifacts/{job-id}/`
- Was das Script dort reinschreibt, taucht im Job-Detail unter "Artefakte" auf
- Endpoints: `GET /jobs/:id/artifacts` (Liste mit name+size+mtime), `GET /jobs/:id/artifacts/:name` (binary download)
- Path-Traversal-Check (resolved path muss innerhalb des Job-Dirs bleiben)
- Client: pro Artefakt ⬇ Download-Button → System-Save-Dialog

### Secrets-Handling
- `env`-Vars im POST-Body werden an `bash -c` weitergegeben (`$DB_PASS` im Script)
- **Werden NICHT in SQLite persistiert** (Migration: alte `env`-Spalte wird gedroppt)
- Tauchen nicht im `/jobs/:id` API-Response auf (kein env-Feld)
- Nur im Process-Env während der Job läuft → mit Process-Exit weg
- Über WireGuard übertragen (verschlüsselt, ChaCha20-Poly1305) — HTTPS nicht nötig im WG-Tunnel

### Was Phase 1 NICHT hat (Phase 2/3)
- Script-Library (persistente Scripte auf dem Server, `PUT /scripts/:name`)
- File-Upload (Mac → Job)
- Cron-Scheduling
- Agent ↔ Task-Bridge

### Geänderte Dateien
- `task-server/` — neuer Unterordner (eigenes package.json, isoliert vom Electron-Build)
- `src/shared/types.ts` — `TaskServerConnection`, `TaskJob`, `TaskJobStatus`
- `src/main/index.ts` — 10 IPC Handler + SSE-Parser
- `src/main/preload.ts` — 11 Bridge-Methoden
- `src/renderer/components/TasksPanel.tsx` — NEU (~350 LoC inkl. Modal)
- `src/renderer/components/NavSidebar.tsx` — `'tasks'` NavView + PlayCircle-Icon
- `src/renderer/components/App.tsx` — `TasksPanel` einbinden
- `src/renderer/styles/index.css` — `.tasks-*` + `.modal-*` Styles (~200 Zeilen)

---

## Cowork Export / Import (One-Click-Onboarding)

Cowork-Repos können als `.json`-Paket exportiert werden — der Empfänger wählt nur einen Zielordner, ClaudeMC macht `git clone` + Registrierung + Settings-Übernahme in einem Schritt.

**Bundle-Format (`claudemcCoworkExport: 'v1'`):**
- `repo`: name, githubUrl, remote, branch, unleashed, wikiProjectEnabled, wikiVaultIndexEnabled
- `settings.settings.local.json`, `settings.wiki-settings.json`: aus `~/.claude/projects/{id}/`

**Bewusst NICHT enthalten:** Source-Code (kommt via `git clone`), Vault-Secrets, GitHub-PATs.

**Import-Flow:**
1. JSON wird gelesen + Manifest-Version geprüft (`v1`)
2. Nutzer wählt **übergeordneten** Ordner (Clone-Target = `parent/{repo.name}`)
3. Wenn Pfad bereits als Cowork-Repo registriert → Fehler
4. Wenn Zielordner kein `.git` enthält → `git clone {githubUrl} {targetPath}` (300s Timeout)
5. Settings nach `~/.claude/projects/{newProjectId}/` schreiben
6. Cowork-Repo in `cowork-repositories.json` registrieren

**UI:**
- **Export**: Cowork-Eintrag aufklappen → **📦** Button neben ⚙/↻
- **Import**: Cowork-Panel Header → **📥** zwischen ⚙ und +

**IPC Handler (`src/main/index.ts`):**
- `export-cowork-repository(repoId)` → `{ success, path?, error?, canceled? }`
- `import-cowork-repository()` → `{ success, repository?, error?, canceled? }`

**Geänderte Dateien:**
- `src/main/index.ts` – `CoworkExportV1` Interface + 2 IPC Handler
- `src/main/preload.ts` – `exportCoworkRepository`, `importCoworkRepository` Bridges
- `src/renderer/components/CoworkPanel.tsx` – `📦`/`📥` Buttons + `onImportCoworkRepository` Prop
- `src/renderer/components/App.tsx` – `handleImportCoworkRepository`, Prop-Wiring

---

## Projekt Export / Import

Projekte können als ClaudeMC-Paket (`.json`) exportiert und auf einem anderen Rechner mit ClaudeMC importiert werden. **Nur die ClaudeMC-Konfiguration** wird übertragen — kein Source-Code, keine Credentials.

**Bundle-Inhalt (`claudemcExport: 'v1'`):**
- `project`: name, type, description, originalPath, originalProjectId (informativ)
- `files.CLAUDE.md`, `files.claudemc.md`: Inhalt der Projektmarker
- `settings.settings.local.json`, `settings.wiki-settings.json`: aus `~/.claude/projects/{id}/`

**Bewusst NICHT enthalten:**
- Source-Code (Empfänger hat den Code via Cowork/Git/eigener Repo)
- Vault-Secrets (Passwörter, OAuth-Tokens, SSH-Passphrases, PATs)
- Server/Mail-Account-Metadaten
- node_modules, .git etc.

**UI:**
- **Export**: ProjectInfoModal Footer → "📦 Exportieren" → Save-Dialog → `.json`
- **Import**: Projekte-Panel Header → "📥" → Open-Dialog für `.json` → Zielordner-Picker → automatische Registrierung

**Import-Flow:**
1. JSON wird gelesen + Manifest-Version geprüft (`v1`)
2. Nutzer wählt Zielordner (Folder Picker)
3. Wenn Pfad bereits registriert → Fehler
4. `CLAUDE.md` + `claudemc.md` werden in Zielordner geschrieben (bestehende Files werden als `.bak-{ts}` gesichert)
5. Settings werden nach `~/.claude/projects/{newProjectId}/` geschrieben
6. Projekt wird in `projects.json` registriert

**IPC Handler (`src/main/index.ts`):**
- `export-project(projectPath)` → `{ success, path?, error?, canceled? }`
- `import-project()` → `{ success, project?, error?, canceled? }`

**Geänderte Dateien:**
- `src/main/index.ts` – `ClaudeMcExportV1` Interface + 2 IPC Handler
- `src/main/preload.ts` – `exportProject`, `importProject` Bridges
- `src/renderer/components/ProjectInfoModal.tsx` – `📦 Exportieren` Button + `handleExport`
- `src/renderer/components/ProjectsPanel.tsx` – `📥` Header-Button + `onImportProject` Prop
- `src/renderer/components/App.tsx` – `handleImportProject`, Prop-Wiring

---

## Fix: ServerMC Sysinfo zeigt keine CPU/RAM/Disk

**Symptom:** In ServerMC blieben alle `CPU —`, `RAM —`, `Disk —` Felder leer. Keine `sysinfo.json` wurde je geschrieben (alle `~/.claude/server-sessions/*/sysinfo.json` fehlten).

**Ursachen (zwei kompoundierende Bugs in `src/main/index.ts`):**

1. **JS-Template-Literal verschluckt Backslash-Escape:** Das Python-Sysinfo-Script enthielt `strip('\"')` als Source. In JS-Backticks wird `\"` zu `"` — der Backslash geht verloren. Der zum Server gesendete Script-Text enthielt also `strip('"')`, was den umschließenden `python3 -c "..."` Block frühzeitig terminierte. Die remote bash brach ab mit `line 38: unexpected EOF while looking for matching '`.
2. **Fragiles Shell-Quoting in `sshExec`/`sshExecWithCreds`:** `"${command.replace(/"/g, '\\"')}"` collapsed `\"` zurück zu `"` im lokalen Shell-Parser → unsicher für jeden Script-Inhalt mit `\"`.

**Fix:**
- `strip('\"')` → `strip(chr(34))` im Python-Script (keine Escapes nötig).
- Neue Helper `sshSpawnWithStdin(args, command, ...)`: spawnt `ssh ... bash -s` und schickt das Script via stdin. Umgeht damit komplett das Argument-Quoting auf lokaler und remote Seite.
- `sshExec` und `sshExecWithCreds` (alle 5 Auth-Pfade) auf den neuen Helper umgestellt.

**Verifiziert:** End-to-end Test gegen einen echten Server → gültiges sysinfo-JSON.

---

## Sub-Agents: Interaktive Rückfragen-Antworten (v1.1.45)

Sub-Agents können jetzt eine Klärungsrunde am Anfang machen — der Nutzer beantwortet ihre Blocker-Frage, danach arbeitet der Agent vollständig autonom weiter.

**Problem vorher:** `claude --print --no-session-persistence` war One-Shot. Wenn Claude eine Rückfrage stellte (z.B. „Bevor ich loslege, brauche ich kurz Klarheit zum Scope"), verpuffte sie ins Leere — kein Eingabefeld, keine Antwort möglich. Agent terminierte ohne die eigentliche Arbeit erledigt zu haben → Token-Verschwendung beim Retry.

**Implementation:**
- `create-agent` läuft jetzt **ohne** `--no-session-persistence` → Session wird auf Disk gehalten
- `session_id` wird aus dem ersten stream-json Event capturet und auf `AgentEntry.sessionId` gespeichert
- Neuer IPC Handler `reply-to-agent(agentId, reply)`:
  - Spawnt `claude --print --resume <sessionId>` im selben cwd, gleiches Modell (opus)
  - Reply wird mit Autonomie-Hinweis prefixed:
    > „Arbeite ab hier vollständig autonom — keine weiteren Rückfragen. Triff sinnvolle Annahmen, dokumentiere sie kurz im Endbericht und liefere ein vollständiges Ergebnis."
  - Output streamt in dieselbe `entry.output` mit Separator `--- Antwort --- / --- Fortsetzung ---`
  - State-Übergang: `done → running → done`

**UI (`AgentsTab.tsx`):**
- Grüne Reply-Sektion oberhalb der bestehenden Feedback-Sektion
- Sichtbar wenn `state === 'done'` und `sessionId` vorhanden
- Textarea + Cmd+Enter Shortcut
- Button: „↩ Antworten & autonom fortsetzen"

**Geänderte Dateien:**
- `src/shared/types.ts` – `Agent.sessionId?: string`
- `src/main/index.ts` – `AgentEntry.sessionId`, session_id capture in `create-agent`, neuer `reply-to-agent` Handler
- `src/main/preload.ts` – `replyToAgent` Bridge
- `src/renderer/components/AgentsTab.tsx` – `replyMap` State, `handleReplyToAgent`, Reply-Sektion
- `src/renderer/styles/index.css` – `.agent-reply-*` Styles (grünes Theme statt violett, um sich von Feedback abzugrenzen)

---

## MacMC – Lokales System-/Prozess-/Autostart-Monitoring (v1.1.43)

Neuer NavSidebar-Tab **MacMC** (Gauge-Icon) zur Verwaltung und Überwachung des lokalen Macs. Drei Sub-Tabs:

### 1. System
Live-Werte alle 2 Sekunden:
- **CPU** (% gesamt + User/System Split)
- **RAM** (used/total GB, mit Progressbar)
- **Swap** (used/total MB)
- **Disk** (root filesystem GB, free/total)
- **Network** ↓↑ (Bytes/Sekunde Delta)
- **Battery** (% + Lade-Status + Restzeit, falls vorhanden)
- **Uptime** + **Load Average** (1m/5m/15m)

Implementation: `top -l 1 -n 0 -s 0` (CPU), `vm_stat` + `sysctl hw.memsize` (RAM), `sysctl vm.swapusage` (Swap), `df -k /` (Disk), `netstat -ib` mit Delta-Berechnung zwischen Calls (Netzwerk), `pmset -g batt` (Battery), `sysctl kern.boottime` (Uptime).

### 2. Prozesse
- `ps -Ao pid,ppid,user,%cpu,%mem,rss,time,command -r` (sortiert nach CPU)
- 150 Top-Prozesse, lokale Filter+Sortierung (CPU/RAM/PID)
- Such-Feld (Kommando, User, PID)
- **Kill-Buttons**: SIGTERM (sanft) + SIGKILL (hart) mit Bestätigungs-Dialog
- Refresh alle 3s

### 3. Autostart
Aggregiert aus 4 Quellen:
- `~/Library/LaunchAgents/*.plist` (User Agents)
- `/Library/LaunchAgents/*.plist` (System Agents)
- `/Library/LaunchDaemons/*.plist` (Daemons)
- Login Items via `osascript -e 'tell application "System Events" to get the name of every login item'`

Pro Eintrag: Label · Programm-Pfad · Typ-Badge (farbig) · Enabled-Status.
- **LaunchAgent enabled?** Vergleich mit `launchctl list` Labels.
- **Toggle**: `launchctl load/unload -w <plist>` (User-Agents direkt, System-Agents/Daemons via sudo), Login Items via osascript `make/delete login item`.
- Filter nach Typ + Suche nach Label/Programm.

### Architektur
- `src/shared/types.ts` – `MacSysinfo`, `MacProcess`, `MacAutostart`, `MacAutostartType` Interfaces
- `src/main/index.ts` – 5 IPC Handler (`get-mac-sysinfo`, `get-mac-processes`, `kill-mac-process`, `get-mac-autostarts`, `toggle-mac-autostart`)
  - `lastNetCounters` Closure für Network-Delta zwischen Calls
  - `readLaunchDir()` + `parsePlistValue()` Helper für Plist-Parsing (regex-basiert, kein Library nötig)
- `src/main/preload.ts` – 5 Bridge-Methoden
- `src/renderer/components/MacMCPanel.tsx` – Container + 3 Sub-Tabs als interne Komponenten (`SystemTab`, `ProcessesTab`, `AutostartsTab`)
- `src/renderer/components/NavSidebar.tsx` – `'macmc'` NavView + Gauge-Icon (Position nach ServerMC)
- `src/renderer/components/App.tsx` – `MacMCPanel` einbinden mit `isActive` Prop (Refresh-Timer pausiert wenn Tab nicht aktiv)
- `src/renderer/styles/index.css` – `.macmc-*` Styles (~200 Zeilen)

### Sicherheit
- Kill-Aktionen erfordern explizite Bestätigung via Modal
- PID ≤ 1 (init) wird blockiert
- LaunchDaemon-Toggle erfordert sudo (Fehlermeldung wenn nicht verfügbar)

---

## Claude Inkognito als Smart-Sort-Provider (v1.1.42)

EmailMC kann ab v1.1.42 statt Ollama auch **Claude im Inkognito-Modus** (`claude --no-session-persistence`) nutzen. Default ist Claude (bessere Klassifizierungsqualität, kein lokales RAM, kein Modell-Load). Ollama bleibt als Alternative erhalten.

**Vorteile Claude vs. Ollama:**
- Bessere Qualität (Haiku 4.5 / Sonnet 4.6 / Opus 4.7)
- Kein lokales RAM/CPU
- Batch in einem Call (40 Mails in einem Roundtrip statt 40 sequentielle)
- Nutzt vorhandenen Claude-CLI-Auth, kein separater API-Key
- `--no-session-persistence` → keine Session-Persistenz auf Disk

**Neue Helpers + IPC Handler (`src/main/index.ts`):**
- `runClaudeInkognito({ systemPrompt, userMessage, model, onChunk })`: generischer Subprozess-Wrapper. Spawnt `claude --print --output-format stream-json --no-session-persistence --model <haiku|sonnet|opus>`, parst stream-events, sammelt Text-Deltas, ruft optional `onChunk()` für Streaming auf.
- `claude-classify-mail-batch(emails, model?)`: alle Mails in EINEM Call (Chunks von 50 für >50 Mails). System-Prompt = Klassifizierungsregeln. User-Prompt = `uid=N | from=... | subject=...` pro Zeile. Output muss JSON-Array sein; Parser sucht ersten `[...]`-Block. Sendet `classify-mail-progress` Events analog zu Ollama. UIDs ohne Match werden auf `FYI` gesetzt.
- `claude-analyze-mail(systemPrompt, userMessage, model?)`: Streaming via `claude-chunk` Event (analog `ollama-chunk`).

**Renderer (`src/renderer/components/EmailMCPanel.tsx`):**
- `AIProvider = 'ollama' | 'claude'`, persistiert in `localStorage('emailmc_ai_provider')`. Default: `'claude'`.
- `claudeModel` in `localStorage('emailmc_claude_model')` (default: `'haiku'`)
- Settings-Modal um **Provider-Toggle** + Claude-Modell-Auswahl (Haiku/Sonnet/Opus) erweitert
- `runSmartSort`, `classifySingleMail`, `runAnalysis`, `runSearch` branchen auf `aiProvider`:
  - Claude: direkter Call, kein Lifecycle-Wrapper
  - Ollama: `withOllama()` Wrapper (Start/Stop)
- Header-Dot: bei Claude violetter Permanent-Dot, bei Ollama der bestehende reachable-Indicator + Power-Button
- Disable-Logik: bei Claude reicht `aiProvider === 'claude'`, kein `ollamaModel` nötig

**Smart Sort mit Claude:** 40 Mails → 1 Subprozess → ~3–5s. Mit Ollama vorher: ~30–60s (Modell-Load + 40 sequentielle Calls).

**Privacy-Hinweis:** Bei Provider='claude' verlassen `from` + `subject` aller Mails (und Body bei Analyse) das Gerät und gehen an die Anthropic API über die lokale Claude CLI. `--no-session-persistence` verhindert nur lokales Session-File-Schreiben. Für sensible Mailboxen → Provider auf Ollama umstellen.

**Geänderte Dateien:**
- `src/main/index.ts` – `runClaudeInkognito()`, `claude-classify-mail-batch`, `claude-analyze-mail`
- `src/main/preload.ts` – `claudeClassifyMailBatch`, `claudeAnalyzeMail`, `onClaudeChunk` Bridges
- `src/renderer/components/EmailMCPanel.tsx` – `AIProvider`, `aiProvider`/`claudeModel` State, Settings-Modal erweitert (Provider-Toggle + Modell-Selector), 4 Funktionen mit Provider-Branch, Header-Dot Provider-aware
- `src/renderer/styles/index.css` – `.emailmc-provider-toggle`, `.emailmc-provider-btn` Styles

---

## Ollama On-Demand Lifecycle (v1.1.42)

Ollama wird ab v1.1.42 nicht mehr permanent erwartet — die App startet `ollama serve` bei Bedarf und beendet es nach der Operation, um RAM/CPU zu sparen.

**Neuer IPC Handler `ollama-ensure-running`:**
- Prüft via `/api/tags` ob Ollama erreichbar
- Falls nicht: `spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' })` mit `unref()`
- Pollt 10s lang (500ms-Intervall) bis Ollama antwortet
- Return: `{ success, started, error? }`

**`withOllama<T>(fn)` Wrapper in `EmailMCPanel.tsx`:**
- Vor `fn()`: `ollamaEnsureRunning(ollamaUrl)` → bei Fehler throw
- `setOllamaReady(true)` → grüner Dot während der Operation
- `try { fn() } finally { killOllama(); setOllamaReady(false) }`

**Angewandt auf:**
- `runSmartSort()` – Batch-Klassifizierung aller Mails
- `classifySingleMail(msg)` – Einzelmail-Brain-Button
- `runAnalysis()` – Zusammenfassung / Antwort / Kategorie / Extraktion
- `runSearch()` – Semantische Suche

**UX:** Beim ersten Klick zeigt der Loading-Indicator "Ollama wird gestartet..." (~3–10s je nach Modell), danach läuft die eigentliche Operation. Nach Abschluss wird Ollama via `pkill` beendet → kein Hintergrund-RAM-Verbrauch.

**Hinweis:** Auch wenn der Nutzer Ollama manuell gestartet hat, wird es nach jeder App-Operation gekillt (bewusste Entscheidung des Nutzers — Ressourcen-sparen hat Priorität).

**Geänderte Dateien:**
- `src/main/index.ts` – `ollamaIsReachable()` Helper, `ollama-ensure-running` IPC Handler
- `src/main/preload.ts` – `ollamaEnsureRunning` Bridge-Methode
- `src/renderer/components/EmailMCPanel.tsx` – `withOllama()` Wrapper, alle 4 Ollama-Aktionen umgestellt

---

## EINKAUF-Kategorie in Smart Sort (v1.1.42)

Neue Smart-Sort-Kategorie `EINKAUF` (violett, `#a855f7`) für Auftragsbestätigungen, Versandmitteilungen, Tracking, Retouren. `RECHNUNG` wurde präzisiert (nur noch echte Rechnungen, Gutschriften, Mahnungen — Auftragsbestätigungen wandern automatisch nach EINKAUF).

**Untergliederung nach Firma:**
- `extractCompanyFromAddress(from)` in `EmailMCPanel.tsx` parst die Domain aus dem `from`-Feld
- `COMPANY_DOMAIN_MAP` mappt bekannte Shops/Versender (Amazon, Otto, Zalando, eBay, DHL, DPD, Hermes, GLS, UPS, FedEx, PayPal, Klarna, MediaMarkt, IKEA, Apple, …) auf saubere Namen
- Unbekannte Domains: Root-Domain (z.B. `shop123.de` → "Shop123") kapitalisiert
- Subdomain-Stripping: `noreply.shop.amazon.de` → `amazon.de` → "Amazon"

**UI:**
- EINKAUF zeigt ▾/▸ Chevron wenn Firmen vorhanden
- Klick auf EINKAUF: setzt View + clear `companyFilter`; zweiter Klick toggled Expand
- Unter EINKAUF: eingerückte Sub-Liste mit `└ Firma  N` (sortiert nach Count, dann alphabetisch)
- Klick auf Firma: filtert `displayedMessages` zusätzlich nach `extractCompanyFromAddress(m.from) === companyFilter`

**Geänderte Dateien:**
- `src/main/index.ts` – `CATEGORIES` + System-Prompt (RECHNUNG präzisiert, EINKAUF mit 4 Beispielen)
- `src/renderer/components/EmailMCPanel.tsx` – `SmartCategory` Type, `SMART_TABS`, `COMPANY_DOMAIN_MAP`, `extractCompanyFromAddress()`, `einkaufExpanded`/`companyFilter` State, `einkaufCompanies` Aggregation, Sub-Liste-Rendering, Mail-Item Farb-Logik
- `src/renderer/styles/index.css` – `.smart-chevron`, `.emailmc-smart-subfolder`, `.smart-subfolder-tree` Styles

---


## Projektstruktur

```
src/
  main/           # Electron Main Process
    index.ts      # Haupt-IPC-Handler, PTY-Management
    preload.ts    # Electron API Bridge zum Renderer
    wiki-generator.ts  # Wiki-Generierungslogik (NEU)
    whatsapp-service.ts
  renderer/       # React Frontend
    components/   # React Komponenten
    styles/       # CSS Styles
  shared/
    types.ts      # Gemeinsame TypeScript Interfaces
```

## Build-Prozess

```bash
npm run build        # TypeScript kompilieren
npm run dev          # Entwicklungsmodus
npm run package      # Electron-App paketieren
```

## Scripts (Recurring Tasks)

### Projekt-Scripts (`scripts/`)

```bash
./scripts/release.sh                    # Vollständiger Release-Flow
./scripts/release.sh -v 1.2.0 -n "..." # Mit Version + Notes
./scripts/release.sh --dry-run          # Nur Vorschau, kein Build/Upload
./scripts/typecheck.sh                  # TypeScript Typecheck
```

**release.sh** — Automatisiert: Version bump → `npm run dist` → Nextcloud Upload (DMG, ZIP, version.json) → git commit/push
- ShareToken wird aus `release/version.json` gelesen (kein Hardcode)
- Interaktiv: fragt nach Version (Patch+1 vorgeschlagen) und Release Notes
- `--no-push`: nur lokal committen

### Globale Scripts (`~/.claude/scripts/`)

```bash
~/.claude/scripts/session-end.sh [PROJECT_PATH]  # Session-Abschluss Checkliste
~/.claude/scripts/md-sync.sh [PROJECT_PATH]       # Geänderte MDs committen
```

**session-end.sh** — Prüft alle registrierten Projekte auf uncommitted changes + unpushed commits + veraltete MD-Dateien

**md-sync.sh** — Staged geänderte MD-Dateien (CLAUDE.md, STATUS.md, CONTEXT.md, DECISIONS.md) und committet sie interaktiv

## Features

### Goose-Style UI Redesign (v1.1.0)

Icon-basierte Sidebar, Home-Dashboard, StatusBar, Light+Dark Theme.

**Neue Dateien:**
- `src/renderer/theme.ts` – Design Tokens (dark/light) + `applyTheme()`
- `src/renderer/ThemeContext.tsx` – React Context (`useTheme()`, `toggleTheme()`, `initTheme()`)
- `src/renderer/components/NavSidebar.tsx` – Icon-Nav (lucide-react), 200px, staggered animation
- `src/renderer/components/HomeView.tsx` – Dashboard: Greeting, Stats-Grid, Quick Actions, Recent Log
- `src/renderer/components/StatusBar.tsx` – 34px Footer: Projekt-Pfad | Claude-Status | WhatsApp+Version+Updates
- `src/renderer/components/ProjectsPanel.tsx` – Aus Sidebar.tsx extrahiert
- `src/renderer/components/CoworkPanel.tsx` – Aus Sidebar.tsx extrahiert

**Geänderte Dateien:**
- `src/renderer/components/App.tsx` – `navView` State (statt `mainView`), ThemeProvider, neues Layout
- `src/renderer/main.tsx` – `initTheme()` vor React-Render
- `src/renderer/styles/index.css` – CSS Custom Properties erweitert, `[data-theme="light"]`, NavSidebar/Home/StatusBar Styles
- `package.json` – `lucide-react` hinzugefügt

**NavView States:** `home | terminal | projects | cowork | agents | orchestrator | wiki | emailmc | servermc`

**Theming:**
- `localStorage('theme')` → `dark` (default) oder `light`
- `[data-theme="light"]` Selector auf `<html>` mit CSS Custom Properties Override
- Kein Flash dank `initTheme()` vor React-Render

**Layout:**
```
.app (flex-column)
  .titlebar
  CoworkNotification
  .app-body (flex-row)
    NavSidebar (200px)
    .app-content (flex-column, flex:1)
      HomeView | ProjectsPanel | CoworkPanel |
      Terminal (display:none wenn inaktiv) |
      OrchestratorTab | WikiPanel | AgentsTab
  StatusBar (34px)
```

### Wiki Integration (v0.7.22)
Automatische Dokumentationsgenerierung für Obsidian Vault:

**Dateien:**
- `src/main/wiki-generator.ts` - Generierungslogik
- `src/shared/types.ts` - WikiSettings Interface
- `src/renderer/components/Sidebar.tsx` - 🔮 Button

**Index-Seite Format:**
```markdown
| Projekt | Beschreibung | Typ | Branch | Status |
```
- Eine Tabelle für alle Projekte (Tools, Staff, Cowork)
- Beschreibung aus CLAUDE.md extrahiert (max 50 Zeichen)
- Cowork mit GitHub-Link in Beschreibung
- Zentrierter Titel mit Vault-Name

**Projekt-Seiten:**
- Zentrierter Titel mit Typ-Badge
- Tags für Obsidian (#projekt/tools, #git/main, etc.)
- Stats-Tabelle: Dateien | Ordner | Größe | Commits | Branch
- CLAUDE.md Dokumentation eingebettet

**Auto-Trigger:**
- PTY Exit (Claude Session endet)
- CLAUDE.md speichern
- Cowork Git Commit
- 🔮 Button in Sidebar

**Sicherheit:**
- Bestehende manuelle Abschnitte bleiben erhalten
- Marker: `<!-- AUTO-GENERATED-START/END -->`
- Changelog: Append-only

### Cowork Repositories
Git-basierte Zusammenarbeit mit Lock-Mechanismus.

### WhatsApp Integration
Claude-Steuerung via WhatsApp (Baileys).

### Deployment
Docker-basiertes Deployment auf Remote-Server.

## Bekannte Patterns

### IPC Handler
```typescript
ipcMain.handle('handler-name', async (_event, arg1, arg2) => {
  // Implementation
  return result;
});
```

### Preload API
```typescript
handlerName: (arg1: Type1, arg2: Type2): Promise<ResultType> =>
  ipcRenderer.invoke('handler-name', arg1, arg2),
```

### Project ID
```typescript
const projectId = projectPath.replace(/\//g, '-');
```

## Einstellungen

Speicherort: `~/.claude/projects/{projectId}/`
- `settings.local.json` - Projekt-Einstellungen (unleashed mode)
- `wiki-settings.json` - Wiki-Konfiguration

## Projekt-Marker (v0.7.5)

Jedes registrierte Projekt erhält eine `claudemc.md` Datei im Root:
- Enthält Projekt-ID, Name, Typ, Ursprünglicher Pfad
- Ermöglicht Wiederherstellung bei Pfadänderungen
- Wird nur einmal erstellt (nicht überschrieben)

## Pfad-Änderung (v0.7.6/v0.7.7)

Wenn Projekte verschoben werden, erkennt der Code Manager dies automatisch:

**Projekte (v0.7.6):**
- `exists` Flag wird bei `get-projects` geprüft
- Warnung im ProjectInfoModal wenn Pfad nicht existiert
- "Pfad ändern" Button öffnet Ordnerauswahl
- IPC Handler: `update-project-path`, `select-new-project-path`

**Cowork-Repos (v0.7.7):**
- `exists` Flag wird bei `get-cowork-repositories` geprüft
- Warnsymbol (⚠️) in der Sidebar bei fehlenden Repos
- "Pfad ändern" Button im Cowork-Eintrag
- IPC Handler: `update-cowork-path`

**Betroffene Dateien:**
- `src/main/index.ts` - IPC Handler
- `src/main/preload.ts` - API Bridge
- `src/renderer/components/ProjectInfoModal.tsx` - Projekt UI
- `src/renderer/components/Sidebar.tsx` - Cowork UI
- `src/renderer/components/App.tsx` - Handler-Logik
- `src/renderer/styles/index.css` - Warning Styles

## Sub-Agents (v0.9.1)

Mehrere `claude --print` Sub-Prozesse parallel in spezifischen Projekt-Verzeichnissen starten, Output streamen und Ergebnis in ClaudeMC-Chat injizieren.

**Dateien:**
- `src/shared/types.ts` - `AgentState`, `Agent` Interface
- `src/main/index.ts` - `agentMap` + 5 IPC Handler (`create-agent`, `stop-agent`, `list-agents`, `clear-agent`, `clear-all-agents`)
- `src/main/preload.ts` - 7 Bridge-Methoden (`createAgent`, `stopAgent`, `listAgents`, `clearAgent`, `clearAllAgents`, `onAgentChunk`, `onAgentListUpdated`)
- `src/renderer/components/AgentsTab.tsx` - Neuer Tab mit Create-Form, Agent-Liste und Output-Panel

**UI:**
- Neuer globaler Tab `[🤖 Agents]` mit Badge für aktive Agents
- Links: Projekt-Selector + Aufgabe-Textarea + "Agent starten"-Button + scrollbare Agent-Liste
- Rechts: Streaming-Output des selektierten Agents + [Stoppen] / [→ ClaudeMC] / [Entfernen]

**ClaudeMC Integration:**
- `[→ ClaudeMC]` Button injiziert Agent-Output als User-Message in ClaudeMC (auf 3000 Zeichen gekürzt)
- Quick-Action "🤖 Sub-Agent starten" in ClaudeMC → wechselt zu Agents-Tab
- `pendingAgentContext` State in App.tsx koordiniert den View-Wechsel

**IPC Events:**
- `agent-chunk`: Streaming-Text (`{ agentId, text }`) oder Abschluss (`{ agentId, done: true }`)
- `agent-list-updated`: Wird gesendet wenn Agents hinzugefügt/entfernt/geändert werden

## Claude Orchestrator + Internes Wiki (v0.9.0)

### Orchestrator
Übergeordneter Claude-Chat der alle Projekte kennt und über die Anthropic API läuft.

**Dateien:**
- `src/renderer/components/OrchestratorTab.tsx` - Chat UI
- `src/main/index.ts` - IPC Handler (`get-orchestrator-key`, `save-orchestrator-key`, `get-project-contexts`, `orchestrator-chat`, `save-orchestrator-log`)
- `src/main/preload.ts` - Bridge Methoden

**API Key Lese-Reihenfolge:**
1. `~/.claude/config.json` → Feld `apiKey`, `bearerToken`, oder `api_key`
2. `process.env.ANTHROPIC_API_KEY`
3. Gespeicherter Key in `{userData}/orchestrator.json`
4. UI-Prompt (einmalig eingeben)

**Model:** `claude-opus-4-5-20251101`

**Features:**
- Streaming Chat (Token für Token via `orchestrator-chunk` IPC Event)
- Projekt-Kontext-Selector (welche CLAUDE.md einbeziehen)
- Konversation persistent via localStorage
- Quick-Actions: Analysiere, Offene Tasks, Erstelle Übersicht
- Chat als Log ins Wiki speichern

### Internes Wiki
Projekt-Dokumentation + Orchestrator-Verlauf in `~/.claude/mc-wiki/`.

**Verzeichnisstruktur:**
```
~/.claude/mc-wiki/
  projects/{projectId}.md  ← aus CLAUDE.md synchronisiert
  logs/{timestamp}-{title}.md  ← Orchestrator Chat-Logs
```

**Dateien:**
- `src/renderer/components/WikiPanel.tsx` - Wiki Viewer
- IPC Handler: `wiki-get-page`, `wiki-save-page`, `wiki-list-pages`, `wiki-sync-project`

**Features:**
- Navigation: Projekte | Verlauf
- Markdown-Renderer (Eigenimplementierung, kein Extra-Package)
- Projekt-Seiten aus CLAUDE.md synchronisierbar (einzeln oder alle)
- Orchestrator-Logs nach Session speichern

### UI-Änderungen (App.tsx)
- `MainView = 'terminal' | 'orchestrator' | 'wiki'`
- Global-Tabs Bar über der Terminal-Area: `[🤖 Orchestrator] [📚 Wiki]`
- Klick auf Projekt-Tab → `setMainView('terminal')`
- Terminal wird nur bei `mainView === 'terminal'` gerendert

### Abhängigkeiten
- `@anthropic-ai/sdk` zu `package.json` hinzugefügt

## Server Credential Manager (v1.1.24)

Pro-Server sichere SSH-Zugangsdaten-Verwaltung über den bestehenden macOS Keychain Vault.

**Neue Datei:** `src/renderer/components/ServerCredentialModal.tsx`
- Formular-Modal: Name, Host, Port, User, Auth-Typ (Key/Passwort/Beide)
- SSH Key-Pfad mit Dateiauswahl-Button
- Passphrase, Passwort, API-Token als verschlüsselte Vault-Einträge
- Projekt-Zuweisung via Chip-Multi-Select
- "Verbindung testen"-Button im Modal

**Vault-Keys:** `server:{id}:sshPassphrase`, `server:{id}:password`, `server:{id}:apiToken`

**Nicht-sensitive Metadaten:** `~/.claude/servers.json`

**Neue IPC Handler (`src/main/index.ts`):**
- `get-servers(projectId?)` – Optional nach Projekt gefiltert (global = leere `projectIds`)
- `save-server(serverData, secrets)` – Erstellt/Aktualisiert + Vault-Secrets
- `remove-server(serverId)` – Löscht JSON-Eintrag + alle Vault-Keys (`vaultDeletePrefix`)
- `test-server-connection(serverId)` – SSH-Echo-Test mit Vault-Credentials
- `ssh-open-terminal(serverId)` – Spawnt SSH als PTY, gibt `{ tabId, serverName }` zurück
- `server-exec(serverId, command)` – Nicht-interaktiver SSH-Befehl

**`sshExecWithCreds()` Helper:**
- `authType === 'password'`: `sshpass -e ssh` + `SSHPASS` Env-Var (kein Passwort-Leak in `ps aux`)
- `authType === 'key'` mit Passphrase: temporäres `SSH_ASKPASS`-Skript (chmod 700, nach 60s gelöscht)
- `authType === 'key'` ohne Passphrase: Standard `ssh -i keyPath`

**`ssh-open-terminal` PTY-Integration:**
- Spawnt SSH direkt als PTY-Prozess (wie `pty-spawn`, aber `ssh` statt Shell)
- `alreadySpawned: true` in Tab-Daten → `Terminal.tsx` überspringt zweiten `ptySpawn`-Aufruf
- Tab erscheint in Terminal-Leiste als `🖥 user@host`

**ServerMCPanel (neues "Zugangsdaten"-Tab):**
- Ersetzt "Server" als Standard-Tab (alt "Server" heißt nun "Docker")
- Server-Liste mit SSH Terminal / Test / Bearbeiten / Löschen Buttons
- Inline Test-Ergebnis (grün/rot) pro Server

**AgentsTab (Server-Dropdown):**
- Optionaler Server-Selector (erscheint wenn Server für das gewählte Projekt vorhanden)
- Server-Kontext wird als Hinweis zur Agent-Aufgabe angehängt (Host, User, Key-Pfad)

**Betroffene Dateien:**
- `src/shared/types.ts` – `ServerCredential` Interface
- `src/main/index.ts` – `vaultHas` Import, `sshExecWithCreds()`, 6 IPC Handler
- `src/main/preload.ts` – 6 Bridge-Methoden
- `src/renderer/components/ServerCredentialModal.tsx` – NEU
- `src/renderer/components/ServerMCPanel.tsx` – `CredentialsTab`, Props `projects`/`onSshTerminal`
- `src/renderer/components/App.tsx` – `onSshTerminal` Callback → SSH Tab hinzufügen
- `src/renderer/components/AgentsTab.tsx` – Server-Dropdown + Server-Kontext in Task
- `src/renderer/components/Terminal.tsx` – `alreadySpawned?` in Tab Interface
- `src/renderer/styles/index.css` – `.modal-backdrop`, `.scm-*`, `.smc-cred-*` Styles

---

## Server aus Projekt hinzufügen + Agent-Feedback (v1.1.25)

### Feature 1: Server direkt aus ProjectInfoModal hinzufügen

`ProjectInfoModal` hat jetzt einen `🖥 Server hinzufügen`-Button im Footer. Er öffnet `ServerCredentialModal` mit dem aktuellen Projekt bereits vorausgewählt.

**Änderungen:**
- `ServerCredentialModal.tsx` – Neues `initialProjectIds?: string[]` Prop; `useState` initialisiert `projectIds` mit `initialProjectIds ?? []`
- `ProjectInfoModal.tsx` – `allProjects?: { id: string; name: string }[]` Prop; `showAddServer` State; `🖥 Server hinzufügen` Button im Footer; `ServerCredentialModal` als nested Modal (position:fixed → kein z-index Problem)
- `App.tsx` – Übergibt `allProjects={projects.map(p => ({ id: p.id, name: p.name }))}` an ProjectInfoModal

### Feature 2: Agent-Feedback-System

Nach Abschluss eines Agents (done/error) erscheint ein Feedback-Bereich:

**UI (`AgentsTab.tsx`):**
- Textarea für Feedback / Verbesserungsvorschlag
- `💾 Ins Projekt speichern` → schreibt Feedback-Datei ins Projekt
- `🔄 Erneut versuchen` → prefixiert Feedback als Kontext und stellt Task ins Formular zurück

**IPC Handler (`save-agent-feedback`):**
- Prüft ob `{projectPath}/tasks/` Verzeichnis existiert → schreibt nach `tasks/agent-iterations.md`
- Fallback: Append an `CLAUDE.md` im Projektverzeichnis
- Format: Markdown mit Timestamp, Task, Output-Snippet (200 Zeichen) und Feedback

**Retry-Logik:**
```
[Feedback aus vorherigem Versuch]
{feedbackText}

Original-Aufgabe:
{originalTask}
```

**Neue State-Variablen in `AgentsTab.tsx`:**
- `feedbackMap: Record<string, string>` – Feedback-Text pro Agent-ID
- `savingFeedback: boolean` – Lade-Indikator
- `feedbackResultMap: Record<string, { success: boolean; path: string }>` – Speicher-Ergebnis

**Neue IPC/Bridge:**
- `save-agent-feedback(agentId, projectPath, task, output, feedback)` → `{ success, path, error? }`
- `saveAgentFeedback` in preload.ts

**CSS:** `.agent-feedback-section`, `.agent-feedback-input`, `.agent-feedback-actions`, `.agent-feedback-result` (mit `.success`/`.error` Modifier)

---

## Claude Console für Server (v1.1.28)

Neuer "Claude"-Button im ServerMC-Zugangsdaten-Tab, der eine SSH-Verbindung zum Server öffnet und direkt `claude` startet.

**Implementierung:**

- `src/main/index.ts` – Neuer IPC Handler `ssh-claude-terminal`:
  - Identisch zu `ssh-open-terminal`, aber SSH-Aufruf mit `claude` als Remote-Befehl
  - `-t` Flag erzwingt Pseudo-TTY (nötig für interaktive claude-Session)
  - Tab-ID-Prefix: `ssh-claude-{serverId}-{timestamp}`
  - Auth: key/passphrase/password (wie ssh-open-terminal)
- `src/main/preload.ts` – Bridge: `sshClaudeTerminal(serverId)`
- `src/renderer/components/ServerMCPanel.tsx`:
  - `Bot`-Icon (lucide-react) importiert
  - `claudeOpeningId` State (separater Ladeindikator)
  - `handleClaudeTerminal()` – ruft `sshClaudeTerminal`, Tab-Name: `🤖 user@host`
  - "Claude"-Button neben "SSH Terminal"-Button

**SSH-Befehl:**
```
ssh -o StrictHostKeyChecking=no -t [-p port] [-i key] user@host claude
```

**Tab-Name im Terminal:** `🤖 user@host`

---

## Terminal Scroll-Button + Scroll-Fix-Verbesserung (v1.1.35)

### Feature: Scroll-to-Bottom Button

Lila runder Button (↓) erscheint als Overlay rechts unten im Terminal wenn der User nach oben gescrollt hat. Klick springt sofort ans Ende und reaktiviert Auto-Scroll.

- `isScrolledUp` State (React) in `Terminal.tsx`
- `activeTabIdRef` Ref — stable Reference für `onScroll`-Handler in `initializeTab`
- `xterm.onScroll()` Listener pro Tab: setzt `isScrolledUp = dist > 2`
- Beim Tab-Wechsel: Scroll-State des neuen Tabs via `buffer.viewportY` lesen
- `handleScrollToBottom` Callback: `scrollToBottom()` + `setIsScrolledUp(false)`
- Button: `.terminal-scroll-btn` — `position: absolute`, `bottom: 16px`, `right: 24px`, `z-index: 10`

### Fix: safeFit Scroll-Position Toleranz

`distFromBottom <= 0` → `distFromBottom <= 2` (2-Zeilen-Toleranz für Streaming-Timing-Jitter).
Explizit `xterm.scrollToBottom()` wenn `wasAtBottom=true` (statt nur nichts tun).

**Ursache des alten Bugs:** Während aktivem Streaming konnte `buffer.length` schneller wachsen als `viewportY` aktualisierte → `distFromBottom` las als 1–2 obwohl User am Ende war → `safeFit` behandelte es als "nach oben gescrollt" → Viewport 2 Zeilen vor Ende gesetzt → xterm Auto-Scroll disabled → User konnte nicht mehr runter scrollen.

### Fix: Copyright in StatusBar rechts

`© Timon Esser` verschoben von `status-bar-left` zu `status-bar-right`, direkt nach `v{appVersion}`.

**Betroffene Dateien:**
- `src/renderer/components/Terminal.tsx` – `useState`, `onScroll`, `handleScrollToBottom`, Button-JSX, safeFit-Verbesserung
- `src/renderer/components/StatusBar.tsx` – Copyright-Position
- `src/renderer/styles/index.css` – `.terminal-scroll-btn` Styles

---

## Selection-Farbe weiß auf dunklem Grund (v1.1.37)

Markierter Text war auf dunklem Untergrund violett (Browser-Default mit `accent: #7c3aed`) → schlecht lesbar. Selection global auf weiß umgestellt.

**Geänderte Dateien:**
- `src/renderer/styles/index.css` – Globale `::selection` + `::-moz-selection` Regel: weißer BG, dunkle Schrift im Dark Mode; invertiert für `[data-theme="light"]`
- `src/renderer/components/Terminal.tsx` – xterm-Theme: `selectionBackground: '#ffffff66'` (statt `#7c3aed44`) + neu `selectionForeground: '#18181b'`

xterm.js rendert auf Canvas/WebGL — CSS `::selection` greift dort nicht, deshalb separate Theme-Property.

---

## Passwort-Manager System-Credentials View (v1.1.36)

Neuer Tab im Passwort-Manager: "🛡 System-Credentials" zeigt read-only alle vom Vault verwalteten Credentials, die Claude MC selbst nutzt – Mail-Passwörter / OAuth2-Tokens, Server-SSH-Passwörter / Key-Passphrasen / API-Tokens, GitHub-PATs.

**Sicherheit:**
- Vault-Keys werden im Backend mit Whitelist-Prefix-Check geprüft (`mail:`, `server:`, `gh:`)
- Eigene Passwort-Einträge (`pw:`) sind absichtlich NICHT abrufbar – die laufen über den dedizierten `get-password-secret` Handler
- Reveal nur 10 Sekunden, Clipboard wird nach 30 Sekunden geleert

**Neue Backend-Datentypen (in `src/main/index.ts`):**
```typescript
SystemCredentialType =
  | 'mail-password' | 'mail-oauth2'
  | 'server-password' | 'server-passphrase' | 'server-apitoken'
  | 'github-token';

SystemCredential {
  vaultKey, type, category: 'Mail'|'Server'|'GitHub',
  label, username, detail?, accountId
}
```

**Neue IPC Handler:**
- `get-system-credentials` → `SystemCredential[]` (aggregiert MailAccounts, Servers, GitHubAccounts → vaultHas-Filter)
- `get-vault-secret(vaultKey)` → `{ secret, error? }` (Whitelist-geprüft)

**Preload Bridge:** `getSystemCredentials`, `getVaultSecret`

**UI (`PasswordManagerPanel.tsx`):**
- Tab-Bar oben: "Eigene Passwörter (N)" / "System-Credentials (M)"
- System-View: Suche + Kategorie-Filter (Mail/Server/GitHub) + gruppierte Liste
- Pro Item: Label · Type-Badge · Username · Detail · 👁 Reveal / 📋 Copy
- OAuth2-Tokens werden formatiert dargestellt (accessToken-Prefix + expiresAt); Copy kopiert nur den AccessToken

**CSS:** `.pwm-tabbar`, `.pwm-tab-btn`, `.pwm-tab-refresh`, `.pwm-tab-content`, `.pwm-sys-view`, `.pwm-sys-toolbar`, `.pwm-sys-info`, `.pwm-sys-list`, `.pwm-sys-group*`, `.pwm-sys-item*`

**Betroffene Dateien:**
- `src/main/index.ts` – `SystemCredential` Interface, 2 IPC Handler
- `src/main/preload.ts` – 2 Bridge-Methoden
- `src/renderer/components/PasswordManagerPanel.tsx` – Tab-State, System-View, Reveal/Copy für Vault-Secrets
- `src/renderer/styles/index.css` – `.pwm-sys-*` + `.pwm-tab*` Styles

---

## GitHub Account Manager + Settings Modal (v1.1.36)

Mehrere GitHub-Accounts mit PAT (Personal Access Token) in den Claude MC Settings hinterlegen. Bei Cowork-Operationen (fetch/pull/push) wird der passende Account automatisch anhand der GitHub-Org/User-URL ausgewählt.

**Neues Modal:** `src/renderer/components/SettingsModal.tsx`
- Öffnet sich per ⚙-Button in `nav-sidebar-bottom`
- Abschnitt "GitHub Accounts": Liste, Hinzufügen, Testen, Löschen
- Token 10 Zeichen verborgen mit 👁-Toggle
- [Testen]-Button ruft `GET https://api.github.com/user` auf → zeigt ✓ login

**Datenmodell (`src/shared/types.ts`):**
```typescript
export interface GitHubAccount {
  id: string;
  username: string;      // z.B. "auto5ecure", "Codimon159"
  displayName?: string;
  hasToken: boolean;     // Token im Vault: gh:{id}:token
  createdAt: string;
}
```

**Speicherort:** `~/.claude/github-accounts.json`, Token im Vault: `gh:{id}:token`

**IPC Handler (`src/main/index.ts`):**
- `get-github-accounts` → `GitHubAccount[]`
- `save-github-account(account, token)` → erstellt/aktualisiert + vaultSet
- `remove-github-account(id)` → JSON filter + vaultDelete
- `test-github-account(id)` → `{ success, login?, error? }` via GitHub API

**`getGitCredentialEnv(repoUrl)` Helper:**
- Parst Owner aus GitHub-URL
- Sucht GitHubAccount (case-insensitive)
- Erstellt Temp-Script `/tmp/ghcred-{id}-{ts}.sh` als GIT_ASKPASS
- Gibt `{ GIT_ASKPASS, GIT_TERMINAL_PROMPT: '0' }` zurück (oder `{}` wenn kein Account)

**Git-Helpers erweitert:** `gitFetch`, `gitPull`, `gitCommitAndPush` akzeptieren optionales `env`-Param

**Cowork-Handler aktualisiert:** `get-cowork-sync-status`, `cowork-pull`, `cowork-commit-push` laden `getGitCredentialEnv` und übergeben es an die Git-Helpers

**App.tsx:** `showSettings` State + `onShowSettings={() => setShowSettings(true)}` an NavSidebar + `<SettingsModal>` render

**CSS:** `.stg-overlay`, `.stg-modal`, `.stg-header`, `.stg-section`, `.stg-gh-row`, `.stg-gh-badge`, `.stg-add-form`, `.stg-btn-*`

**Betroffene Dateien:**
- `src/shared/types.ts` – `GitHubAccount` Interface
- `src/main/index.ts` – `getGitCredentialEnv`, `loadGitHubAccounts`, `saveGitHubAccounts`, 4 IPC Handler, git-Helper env-Param, Cowork-Handler erweitert
- `src/main/preload.ts` – 4 Bridge-Methoden
- `src/renderer/components/SettingsModal.tsx` – NEU
- `src/renderer/components/App.tsx` – `showSettings` State + Modal
- `src/renderer/styles/index.css` – `.stg-*` Styles

---

## Passwort Manager (v1.1.35)

Globaler verschlüsselter Passwort-Manager in der NavSidebar (KeyRound-Icon).

**Neue Datei:** `src/renderer/components/PasswordManagerPanel.tsx`

**Datenmodell (`src/shared/types.ts`):**
```typescript
export interface PasswordEntry {
  id: string;
  name: string;       // z.B. "GitHub", "AWS Console"
  url?: string;
  username: string;
  category: string;   // z.B. "Web", "Server", "Privat"
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Passwort liegt im Vault: pw:{id}:password
}
```

**Speicherort:** `~/.claude/passwords.json`
**Vault-Key:** `pw:{id}:password` (macOS Keychain via safeStorage)

**IPC Handler (`src/main/index.ts`):**
- `get-passwords` → `PasswordEntry[]`
- `save-password(entry, password)` → erstellt/aktualisiert + vaultSet
- `remove-password(id)` → aus JSON + vaultDelete
- `get-password-secret(id)` → `{ password: string | null }` aus Vault

**Preload Bridge:** `getPasswords`, `savePassword`, `removePassword`, `getPasswordSecret`

**Features:**
- Zweispaltig: Links Listenansicht (Suche + Kategorie-Filter), rechts Detail/Formular
- 👁 Passwort 10 Sekunden sichtbar (Auto-Hide)
- 📋 Kopieren → Clipboard, nach 30s automatisch geleert
- Passwort-Generator: Länge 8–64, Slider, Checkboxen (A–Z / a–z / 0–9 / Sonderzeichen)
- Kategorien frei wählbar mit Vorschlägen via `<datalist>`
- CRUD vollständig (Anlegen, Bearbeiten, Löschen)

**NavSidebar:** NavView um `'passwords'` erweitert, Icon: `KeyRound` aus lucide-react

**Betroffene Dateien:**
- `src/shared/types.ts` – `PasswordEntry` Interface
- `src/main/index.ts` – `loadPasswords`, `savePasswords`, 4 IPC Handler
- `src/main/preload.ts` – 4 Bridge-Methoden
- `src/renderer/components/PasswordManagerPanel.tsx` – NEU
- `src/renderer/components/NavSidebar.tsx` – NavView + KeyRound
- `src/renderer/components/App.tsx` – Import + Render
- `src/renderer/styles/index.css` – `.pwm-*` Styles

---

## Copyright Footer, Wiki Refresh, Agent-Übersicht (v1.1.34)

### Feature 1: Copyright im Footer

`© Timon Esser` als kleine, gedimmte Zeile links im StatusBar (`.status-copyright`, 9px, opacity 0.55).

### Feature 2: Wiki Nav — Refresh-Button pro Projekt

Linke Nav-Leiste im Wiki zeigt jetzt **alle** Projekte & Cowork-Repos (auch noch nicht synchronisierte):
- **Grüner Punkt** = bereits synchronisiert → Klick öffnet die Wiki-Seite
- **Grauer Punkt** = noch kein Wiki-Eintrag → Klick erstellt ihn per Sync
- **↻ Button** (erscheint bei Hover) → Refresh aus CLAUDE.md, direkt aus der Nav

**CSS:** `.wiki-nav-entry`, `.wiki-nav-entry-label`, `.wiki-nav-entry-dot.synced/unsynced`, `.wiki-nav-refresh-btn`

### Feature 3: Agent-Übersichtsseite

Wenn kein Agent ausgewählt ist (rechtes Panel war leer), zeigt das Panel jetzt ein **Card-Grid** aller Agents:
- Eine Karte pro Agent: Status-Badge, Projektname, Task-Snippet, letzten 3 Zeilen Output
- Farbiger linker Rand: gelb (läuft), grün (fertig), rot (fehler), grau (ausstehend)
- **■ Stop / ✕ Entfernen** Buttons direkt in der Karte
- Klick auf Karte → Detail-Ansicht

**Neue Komponente:** `AgentOverview` (am Ende von `AgentsTab.tsx`)
**CSS:** `.agent-overview`, `.agent-overview-grid`, `.agent-overview-card`, `.agent-overview-running/done/error/pending`

### Fix: Orchestrator — alle Projekte immer auto-selektiert (v1.1.33)

Wenn `projects` und `coworkRepos` in separaten Render-Zyklen ankamen (zwei getrennte IPC-Calls), selektierte der alte `initialized`-Guard nur die erste Batch. Cowork-Repos blieben dauerhaft abgewählt.

**Fix in `OrchestratorTab.tsx`:** `initialized`-State entfernt, ersetzt durch `seenPathsRef` (Ref auf Set). Jeder neue Pfad der noch nicht im Set ist, wird automatisch zur Selektion hinzugefügt — unabhängig vom Timing.

---

## Terminal Scroll Fix + safeFit (v1.1.32)

**Ursache des Scroll-Bugs:** `overflow-y: auto !important` auf `.xterm-viewport` (in `index.css`) überschrieb xterm.js's benötigtes `overflow-y: scroll`. Mit `auto` erscheint/verschwindet die Scrollbar wenn Content wächst → Terminalbreite ändert sich → ResizeObserver feuert → `fit()` → `ptyResize` → mehr Output → Feedback-Loop → Scroll-Position springt.

**Drei-teiliger Fix:**

**1. CSS** (`src/renderer/styles/index.css`):
- Beide `overflow-y: auto !important` Overrides auf `.xterm-viewport` entfernt
- xterm.js benötigt `overflow-y: scroll` (immer sichtbare Scrollbar) für korrekte Breitenberechnung

**2. `safeFit()` Funktion** (`src/renderer/components/Terminal.tsx`):
```typescript
function safeFit(fitAddon: FitAddon, xterm: XTerm): void {
  const buffer = xterm.buffer.active;
  const distFromBottom = buffer.length - buffer.viewportY - xterm.rows;
  const wasAtBottom = distFromBottom <= 0;
  fitAddon.fit();
  if (!wasAtBottom) {
    const newLength = xterm.buffer.active.length;
    const targetLine = Math.max(0, newLength - xterm.rows - distFromBottom);
    xterm.scrollToLine(targetLine);
  }
}
```
→ Bewahrt Scroll-Position wenn Nutzer nach oben gescrollt ist

**3. scrollback auf 5000** (war Standard 1000):
```typescript
const xterm = new XTerm({ scrollback: 5000, ... });
```

**Alle `fitAddon.fit()` Aufrufe** durch `safeFit(fitAddon, xterm)` ersetzt.

---

## Ollama-Beenden-Button + Release-Automation (v1.1.31)

### Feature: Ollama-Beenden-Button in EmailMC

Roter Power-Button im EmailMC-Header (nur sichtbar wenn Ollama erreichbar ist).

- `kill-ollama` IPC Handler: `pkill -x ollama || pkill -f "ollama serve"`
- `killOllama()` Bridge in preload.ts
- `killingOllama` State + `handleKillOllama()` in EmailMCPanel
- Nach Kill: 800ms warten → Ollama-Status neu prüfen

### Feature: Release-Automation-Scripts

`scripts/release.sh`: Vollautomatischer Release-Flow
- Argumente: `-v VERSION`, `-n "NOTES"`, `--yes` (non-interaktiv), `--dry-run`, `--no-push`
- Liest `shareToken` + `writeToken` aus `release/version.json`
- Löscht alte Version auf Nextcloud vor Upload (verhindert HTTP 507)
- Flow: version bump → `npm run dist` → delete old → upload DMG/ZIP/version.json → git commit/push

`scripts/typecheck.sh`: TypeScript-Typecheck-Shortcut

`~/.claude/scripts/session-end.sh`: Session-End-Checkliste (global, nicht im Repo)

`~/.claude/scripts/md-sync.sh`: MD-Datei-Commit-Helper (global, nicht im Repo)

**`release/version.json`** enthält jetzt `writeToken` für Nextcloud-Schreibzugriff.

---

## Tab-Fixes, Panel-Indikatoren, Beenden-Bestätigung (v1.1.30)

### Fix 1: Tab-Navigation beim Wechsel zu bestehendem Tab

`handleAction` und `handlePreFlightProceed` riefen bei einem bereits offenen Tab `setActiveTabId()` auf, aber nie `setNavView('terminal')`. Der Nutzer blieb im Projekte-/Cowork-Panel und konnte den Tab nicht sehen.

**Fix (`App.tsx`):**
```typescript
if (existingTab) {
  setActiveTabId(existingTab.id);
  setNavView('terminal');  // ← neu
  setSelectedProject(project);
  return;
}
```

### Fix 2: Offene Tabs in Menü-Panels anzeigen

Grüner Dot-Indikator (`●`) neben jedem Eintrag, der einen aktiven Terminal-Tab hat:
- **ProjectsPanel**: `openProjectPaths?: Set<string>` → Dot nach Projektname
- **CoworkPanel**: `openCoworkRepoIds?: Set<string>` → Dot nach Repo-Name
- **ServerMCPanel**: `openServerIds?: Set<string>` → Dot nach Servername

**App.tsx** berechnet drei `useMemo`-Sets:
```typescript
const openProjectPaths = useMemo(() => new Set(tabs.map(t => t.projectPath).filter(Boolean)), [tabs]);
const openCoworkIds = useMemo(() => new Set(Object.values(coworkTabMap)), [coworkTabMap]);
const openServerIds = useMemo(() => { /* sshTabServerMap × aktive tabs */ }, [tabs, sshTabServerMap]);
```

Neuer `sshTabServerMap: Record<string, string>` (tabId → serverId) in App.tsx, wird in `doCloseTab` bereinigt.
`onSshTerminal`-Callback erweitert: 3. Argument `serverId?: string`.

**CSS:** `.tab-open-dot { width:7px; height:7px; border-radius:50%; background:#22c55e; box-shadow:0 0 4px #22c55e88; }`

### Fix 3: Beenden-Bestätigung

`mainWindow.on('close', ...)` in `src/main/index.ts` prüft vor dem Schließen:
- `ptyProcesses.size` – aktive Terminal-Sessions
- `activeLocks.size` – aktive Cowork-Locks

Falls > 0: `event.preventDefault()` + `dialog.showMessageBox` mit Liste der offenen Aktivitäten.
Bei Bestätigung: `forceQuit = true` → `mainWindow.destroy()`.
`before-quit` Handler (Lock-Cleanup) läuft danach normal.

### Fix 4: Sysinfo Auto-Fetch

`loadServers()` in `ServerMCPanel.tsx`: Wenn `loadServerSysinfo()` null zurückgibt (kein Cache), wird `fetchServerSysinfo()` automatisch im Hintergrund ausgeführt. Sysinfo erscheint sobald die SSH-Verbindung antwortet.

---

## Server Intelligence – Sysinfo, Purpose, SSH-Key-Autosetup (v1.1.29)

### Feature 1: Sysinfo-Anzeige pro Server (Live + gecacht)

Zweite Zeile unter jedem Server-Eintrag in `CredentialsTab`:
```
CPU 23% · RAM 1.2/4 GB · Disk 18/50 GB · Ubuntu 22.04 · ↑ 3d 14h  [↻]
Zweck: Webserver, Nginx, Postgres
```

**`[↻]` Button:** Ruft `fetch-server-sysinfo` auf → SSH-Script → JSON parsen → `~/.claude/server-sessions/{id}/sysinfo.json` schreiben + UI updaten.

**On-Mount-Load:** `loadServerSysinfo()` für jeden Server → gecachte Werte sofort sichtbar.

### Feature 2: Purpose-Freitext pro Server

- Inline-Edit: Klick auf den Purpose-Text → Input erscheint → Enter/Blur speichert
- Im ServerCredentialModal: neues Feld "Zweck / Services"
- IPC Handler: `save-server-purpose` → `servers.json`

### Feature 3: SSH-Key-Autosetup

Beim ersten SSH-Terminal oder Claude-Session-Open wird automatisch versucht, den lokalen Pubkey (`~/.ssh/id_ed25519.pub` oder `id_rsa.pub`) auf den Server zu hinterlegen (via `authorized_keys`). Nach Erfolg: `~/.claude/server-sessions/{id}/ssh-key-setup.done` → wird nicht wiederholt.

### Feature 4: Orchestrator-Kontext für Server

`get-project-contexts` liefert zusätzlich einen `__servers__`-Key mit Markdown-Kontext aller Server (Host, OS, CPU/RAM/Disk, Uptime, Purpose, Server-Session-CLAUDE.md).

**Neue IPC Handler (`src/main/index.ts`):**
- `fetch-server-sysinfo(serverId)` – SSH-Script (Python3/Bash-Fallback), JSON → sysinfo.json
- `load-server-sysinfo(serverId)` – liest gecachte sysinfo.json
- `setup-ssh-key(serverId)` – hinterlegt lokalen Pubkey in authorized_keys
- `save-server-purpose(serverId, purpose)` – updated servers.json

**Neue Datenstrukturen (`src/shared/types.ts`):**
- `ServerCredential.purpose?: string`
- `ServerSysinfo` Interface: hostname, os, cpu, mem, disk, uptime, fetchedAt

**Preload Bridge:** `fetchServerSysinfo`, `loadServerSysinfo`, `setupSshKey`, `saveServerPurpose`

**CSS:** `.smc-sysinfo-row`, `.smc-sysinfo-stat`, `.smc-sysinfo-sep`, `.smc-refresh-btn`, `.smc-purpose-row`, `.smc-purpose-text`, `.smc-purpose-input`

**Betroffene Dateien:**
- `src/shared/types.ts` – `ServerCredential.purpose?`, neues `ServerSysinfo` Interface
- `src/main/index.ts` – `setupSshKeyOnServer()`, `getServerSessionDir()`, 4 neue IPC Handler, `get-project-contexts` mit Server-Kontext, auto-SSH-key in `ssh-open-terminal` + `claude-server-session`
- `src/main/preload.ts` – 4 neue Bridge-Methoden
- `src/renderer/components/ServerCredentialModal.tsx` – Purpose-Feld
- `src/renderer/components/ServerMCPanel.tsx` – `sysinfoMap`, sysinfo-Zeile, purpose-Zeile, `handleFetchSysinfo`, `handlePurposeSave`
- `src/renderer/styles/index.css` – neue `.smc-sysinfo-*` + `.smc-purpose-*` Styles

---

## Bug-Fixes: Schwarzes Fenster + SSH-Passwort-Auth (v1.1.27)

### Fix 1: Schwarzes Fenster nach Tab-Schließen

**Ursache:** `doCloseTab` setzte `activeTabId` auf das letzte Tab, aber wenn alle Tabs geschlossen wurden, blieb `navView` auf `'terminal'` bei `activeTabId = null` → leerer Terminal-Bereich = schwarzes Fenster.

**Fix (`App.tsx`):**
```typescript
if (newTabs.length === 0) setNavView('home');
```

### Fix 2: SSH-Passwort-Auth ohne sshpass (macOS)

**Ursache:** `sshExecWithCreds` nutzte `sshpass -e ssh` für Passwort-Auth. `sshpass` ist kein Standard-macOS-Tool und war nicht installiert → SSH-Fehler bei MDMC-Client-Generierung und Server-SSH-Befehlen.

**Fix (`index.ts` – `sshExecWithCreds`):**
- Fallback auf `SSH_ASKPASS`-Mechanismus wenn `sshpass` nicht vorhanden
- Temporäres Shell-Skript (`/tmp/sshpw-{id}-{ts}.sh`, chmod 700) wird erzeugt, das das Passwort ausgibt
- `SSH_ASKPASS` + `DISPLAY=:0` + `SSH_ASKPASS_REQUIRE=force` als Env-Vars für SSH
- Skript wird nach der SSH-Verbindung gelöscht (30s Fallback-Timer)

```typescript
const tmpPwScript = path.join(os.tmpdir(), `sshpw-${server.id}-${Date.now()}.sh`);
fs.writeFileSync(tmpPwScript, `#!/bin/sh\necho '${password.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
// env: { SSH_ASKPASS: tmpPwScript, DISPLAY: ':0', SSH_ASKPASS_REQUIRE: 'force' }
```

---

## Persönliche ToDo-Liste + Agent-Löschen-Fix (v1.1.26)

### Feature: Globale ToDo-Liste

Neuer Sidebar-Tab „Todos" (`CheckSquare`-Icon) mit persönlicher Aufgabenliste, gespeichert global in `~/.claude/todos.json`.

**Datenmodell (`src/shared/types.ts`):**
```typescript
export interface Todo {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  delegatedAgentId?: string;   // gesetzt wenn an Agent delegiert
  delegatedAt?: string;        // ISO-Timestamp
  createdAt: string;
  completedAt?: string;
}
```

**IPC Handler (`src/main/index.ts`):**
- `get-todos` – lädt `~/.claude/todos.json`
- `add-todo(t)` – prepend neues Todo, sendet `todos-updated` Event
- `update-todo(id, updates)` – partial update
- `delete-todo(id)` – filtert Todo heraus

**Preload Bridge:** `getTodos`, `addTodo`, `updateTodo`, `deleteTodo`, `onTodosUpdated`

**UI (`src/renderer/components/TodosPanel.tsx`) — NEU:**
- Filter-Tabs: Alle | Offen | Erledigt | Delegiert
- Add-Form: Input + optionale Beschreibung (expandiert bei Fokus)
- Todo-Item: Checkbox (☐/☑/⚡) + Titel + Beschreibung + Aktionen
- `→🤖` Button → öffnet Inline-Delegate-Panel (Projekt-Select + Starten)
- Delegate-Flow: `createAgent()` → `updateTodo({ delegatedAgentId })` → wechselt zu Agents-Tab
- ⚡ Badge auf NavSidebar-Item für offene Todos

**NavSidebar:**
- `NavView` erweitert um `'todos'`
- `todoCount` Prop → Badge für offene, nicht delegierte Todos
- Icon: `CheckSquare` aus lucide-react

**App.tsx:**
- `todos: Todo[]` State + `todoCount` Computed
- Lädt Todos im initialen `Promise.all`
- `onTodosUpdated`-Listener für Echtzeit-Updates
- Rendert `<TodosPanel>` wenn `navView === 'todos'`

### Bugfix: Agent-Entfernen bei laufendem Agent

`handleClearAgent` stoppte laufende Agents nicht, da der „Entfernen"-Button nur für `state !== 'running'` angezeigt wurde.

**Fix (`AgentsTab.tsx`):**
- „Entfernen"-Button immer anzeigen (alle States)
- `handleClearAgent`: prüft ob `state === 'running'` → ruft `stopAgent()`, wartet 300ms, dann `clearAgent()`

---

## MDMC – Mobile Device Management (v1.1.27)

Neuer Sidebar-Tab „MDMC" (MonitorSmartphone-Icon) zur Verwaltung von Remote-Clients über WireGuard + WebSocket.

### Architektur
- **WireGuard**: Clients verbinden sich über WG-Tunnel ins `10.0.0.0/24` Netz
- **WebSocket-Server**: Port 4242 auf dem Mac (auto-start beim App-Start)
- **Remote-Terminal**: xterm.js ↔ WebSocket ↔ Node.js-Agent auf dem Client
- **Sysinfo-Panel**: CPU/RAM/Disk/Uptime live via 30s-Heartbeat

### Datenmodell (`src/shared/types.ts`)
```typescript
MDMCClient { id, name, platform, wgPubKey, wgIp, authToken, wgServerId, wgInterface, createdAt, notes? }
ClientSysInfo { hostname, os, cpu (%), mem ({ used, total } MB), disk, uptime (s), battery?, location? }
MDMCSettings { wsPort (4242), macWgIp (10.0.0.2), wgInterface (wg0), wgSubnet (10.0.0.0/24), nextIpIndex }
```
**Speicherort:** `~/.claude/mdmc-clients.json`, `~/.claude/mdmc-settings.json`

### WebSocket-Protokoll
```
Client→Server: hello { token, platform, hostname }  →  Server: hello-ok { clientId }
Client→Server: sysinfo { cpu, mem, disk, uptime, ... }
Server→Client: exec-pty { ptyId, cols, rows }
Client→Server: pty-data { ptyId, data (base64) }
Server→Client: pty-input { ptyId, data }
```

### Neue Datei: `src/main/mdmc-server.ts`
- `generateWireGuardKeys()` – pure Node.js x25519, kein externen wg-Befehl nötig
- `startMDMCServer(port, clients, onEvent)` – WebSocket-Server
- `sendToClient(clientId, msg)` – Nachricht an verbundenen Client
- `generateClientPackage(opts)` – generiert `wg-claudemc.conf`, `agent.js`, `install.sh`, `install.ps1`

### IPC-Intercept in `src/main/index.ts`
- `mdmcPtyMap: Map<string, string>` – tabId → clientId
- `pty-write` Handler: wenn tabId in mdmcPtyMap → `sendToClient(clientId, { type: 'pty-input', ... })`
- `pty-resize` Handler: analog → `sendToClient(clientId, { type: 'pty-resize', ... })`
- MDMC-Server leitet `pty-data` (base64→utf8) und `pty-exit` an Renderer weiter
- Terminal.tsx braucht **keine** Änderungen (gleiche IPC-Events)

### WireGuard-Peer via SSH
```
wg show wg0 public-key              → Server-PubKey abfragen
wg set wg0 peer <pub> allowed-ips <ip>/32  → Peer live hinzufügen
tee -a /etc/wireguard/wg0.conf     → persistenter Eintrag
```

### UI-Komponenten
- **MDMCPanel.tsx**: Links Client-Liste, rechts Sysinfo (Progressbars) / Info / Terminal-Button
- **ClientGeneratorModal.tsx**: 3-Schritt-Wizard (Config → Generate → Download/QR)

### NavSidebar
- `NavView` erweitert um `'mdmc'`
- Icon: `MonitorSmartphone` (lucide-react)
- Badge: Anzahl online verbundener Clients
- `mdmcOnlineCount` Prop in NavSidebar + App.tsx

### Abhängigkeiten
- `ws@^8.18.0` (NEU) – WebSocket-Server im Main Process
- `@types/ws` (NEU) – TypeScript-Typen
- `qrcode` war bereits vorhanden

### Betroffene Dateien
- **NEU** `src/main/mdmc-server.ts`
- **NEU** `src/renderer/components/MDMCPanel.tsx`
- **NEU** `src/renderer/components/ClientGeneratorModal.tsx`
- `src/shared/types.ts` – MDMCClient, ClientSysInfo, MDMCSettings
- `src/main/index.ts` – IPC-Handler + pty-write/pty-resize Intercept
- `src/main/preload.ts` – 12 Bridge-Methoden
- `src/renderer/components/NavSidebar.tsx` – mdmc + MonitorSmartphone
- `src/renderer/components/App.tsx` – mdmcOnlineCount State, MDMC Event-Listener, Terminal-Handler
- `src/renderer/styles/index.css` – `.mdmc-*` Styles

---

## Fix: UI-Hang bei Button-Klicks (v1.1.23)

**Ursache:** 67 `execSync`-Aufrufe im Electron Main Process blockierten den gesamten V8-Event-Loop. Während git fetch/pull/push, SSH-Verbindungen oder Deployment-Operationen konnte der Main Process keine anderen IPC-Nachrichten verarbeiten → UI schien eingefroren.

**Fix:** Alle `execSync`-Aufrufe durch `await execAsync` (= `util.promisify(exec)`) ersetzt.

**Konvertierte Bereiche:**
- Git-Hilfsfunktionen: `getGitBranch`, `isGitDirty`, `gitFetch`, `getAheadBehind`, `getChangedFiles`, `hasConflicts`, `getConflictFiles`, `gitPull`, `gitCommitAndPush`, `getConflictDetails`, `isGitRepository`, `getRemoteUrl`, `getCurrentBranch`, `getDefaultRemote`
- Cowork IPC-Handler: `get-cowork-sync-status`, `cowork-pull`, `cowork-commit-push`, `check-cowork-lock`, `create-cowork-lock`, `release-cowork-lock`, `force-release-cowork-lock`, `clone-cowork-repository`
- Wiki-Handler: `update-project-wiki`, `regenerate-vault-index`, `update-cowork-wiki`, `wiki-sync-project`
- Deployment: `sshExec`, `scpUpload`, `run-deployment`, `deployment-rollback`, `get-deployment-status`, `get-deployment-logs`, `test-ssh-connection`

**Ausnahme:** `before-quit`-Handler benutzt weiterhin `execSync` (App schließt sich ohnehin).

**Import:** `import { promisify } from 'util'; const execAsync = promisify(exec);`

---

## Bug-Fix: Terminal abgeschnitten + EmailMC Auto-Refresh (v1.1.22)

### Terminal-Abschnitt nach Tab-Wechsel / kein Scroll

**Ursache:** `fitAddon.fit()` wurde zu früh aufgerufen (vor Browser-Layout-Paint). Beim Wechsel zurück zum Terminal-navView änderte sich `activeTabId` nicht → der `useEffect([activeTabId])` löste nicht neu aus.

**Fixes in `src/renderer/components/Terminal.tsx`:**
- **`isVisible` Prop**: Neues `boolean` Prop, steuert ob Terminal-Panel gerade sichtbar ist
- **Double-RAF bei `isVisible`-Wechsel**: `useEffect([isVisible, activeTabId])` mit zwei verschachtelten `requestAnimationFrame`-Calls → Browser hat Layout gezeichnet bevor `fitAddon.fit()` misst
- **Double-RAF beim Tab-Wechsel**: Ersetzt vorherigen `setTimeout(50ms)` im `useEffect([activeTabId])`
- **ResizeObserver debounce**: 32ms-Debounce verhindert Fit→Resize→Fit-Feedback-Schleife

**Fix in `src/renderer/components/App.tsx`:**
- `isVisible={navView === 'terminal'}` an Terminal-Komponente übergeben

### EmailMC Auto-Refresh nur bei aktivem Panel
- `isActive` Prop auf EmailMCPanel, verhindert IMAP-Verbindungen wenn Panel nicht sichtbar

---

## ClaudeMC Vault: Verschlüsselte Zugangsdaten (v1.1.21)

Alle Passwörter/OAuth-Tokens werden verschlüsselt gespeichert – nicht mehr als Plaintext in JSON.

**Neue Datei:** `src/main/vault.ts`
- Nutzt Electron `safeStorage` (ein Keychain-Eintrag für die gesamte App)
- Blobs als Base64 in `~/.claude/vault.enc.json` (mode 0600)
- Key-Schema: `mail:{id}:password`, `mail:{id}:oauth2`
- Exports: `vaultSet`, `vaultGet`, `vaultDelete`, `vaultDeletePrefix`, `VAULT_SENTINEL`

**`VAULT_SENTINEL = '__vault__'`**: Platzhalter in JSON-Dateien wenn echtes Passwort im Vault liegt.

**Startup-Migration:** `app.whenReady()` verschiebt Plaintext-Passwörter automatisch in den Vault.

**Sicherheit:** Claude CLI Subprozesse können Electron `safeStorage` nicht aufrufen – kein Keychain-Zugriff durch Claude.

---

## EmailMC Auto-Refresh + Unread-Badge (v1.1.20)

- 2-Minuten `setInterval` Auto-Refresh im Hintergrund (kein Loading-Spinner)
- Unread-Badge auf Mail-Icon in NavSidebar
- `searchQueryRef` verhindert Überschreiben aktiver Suche beim Refresh
- `onUnreadCountChange` Callback von EmailMCPanel → `emailUnreadCount` State in App.tsx → NavSidebar badge

---

## EmailMC Loading + Einzelklassifikation (v1.1.19)

- **App-Start Loading**: `startLoading()` vor `Promise.all([loadProjects, loadCowork, ...])`, `stopLoading()` in `.finally()` – Buttons während Laden nicht klickbar
- **Brain-Button pro Mail**: `classifyingUid` State + `classifySingleMail()` Funktion – einzelne Mails mit Ollama klassifizieren (sichtbar bei hover via `.emailmc-classify-btn`)

---

## EmailMC Smart Sort Timeout (v1.1.18)

**Problem:** Smart Sort hing bei 38/40 (2 Mails hingen ewig in Ollama).

**Fix:** 30s Timeout in `ollamaCollect()`:
```typescript
function ollamaCollect(urlStr, model, messages, options?, timeoutMs = 30000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout`)), timeoutMs);
    ollamaStream(..., () => { clearTimeout(timer); resolve(text); }, (err) => { clearTimeout(timer); reject(err); });
  });
}
```

---

## EmailMC Smart Sort + RECHNUNG-Kategorie (v1.1.17)

**Neue Kategorie RECHNUNG** für Rechnungen, Angebote, Bestellungen, Zahlungsbestätigungen.

**SmartCategory:** `'URGENT' | 'ACTION' | 'RECHNUNG' | 'FYI' | 'NOISE'`

**Ollama-Prompt mit Few-Shot-Beispielen** zur Verbesserung der Klassifizierungsgenauigkeit:
```
Subject: Rechnung 2024-001 → RECHNUNG
Subject: Bitte Angebot prüfen → ACTION
Subject: Neue Zertifizierung in der Signatur, ISO → ACTION
```

**Dateien:** `src/main/index.ts`, `src/renderer/components/EmailMCPanel.tsx`

## EmailMC Smart Folders + Global Loading (v1.1.14–v1.1.16)

**Smart Sort (Ollama-basiert):**
- Virtuelle Ordner-Klassifizierung (kein IMAP-Move, nur lokal)
- 5 Kategorien: URGENT, ACTION, RECHNUNG, FYI, NOISE
- Brain-Icon Button → klassifiziert alle E-Mails des aktuellen Ordners via Ollama
- Ergebnisse als Baum unter dem Postfach (Accounts-Pane)
- Cache in localStorage: `emailmc_smart_{accId}_{folder}`
- `ollamaCollect()` nutzt bewährtes `ollamaStream` intern (fixes NDJSON-Problem)

**Bugfixes:**
- **Hang bei 40/40**: `updateLoadingLabel()` hinzugefügt (ohne Counter-Increment), Progress-Handler nutzt diese statt `startLoading()`
- **Alle FYI**: `ollamaPost(stream:false)` lieferte NDJSON → `JSON.parse()` fehlschlug → Fallback FYI. Fix: `ollamaCollect()` via `ollamaStream`
- **Cache-Reset**: `runSmartSort()` löscht `mailCategories` am Start

**Global Loading Indicator:**
- `src/renderer/utils/loading.ts`: `startLoading(label)`, `stopLoading()`, `updateLoadingLabel(label)`
- `src/renderer/components/LoadingIndicator.tsx`: Floating Pill mit spinning MC-Ring
- Eingebunden in EmailMCPanel, OrchestratorTab, AgentsTab

## Orchestrator Kontext-Persistenz (v1.1.13)

Ausgewählte Projekt-Checkboxen im Orchestrator werden in localStorage gespeichert und beim App-Start wiederhergestellt.

**Key:** `orchestrator-selected-contexts` in `OrchestratorTab.tsx`

## Fix: Claude CLI exit code 127 (v1.1.12)

**Ursache:** Electron-App vom Finder/Dock geöffnet → kein Shell-PATH geerbt → `node` nicht gefunden wenn `claude` (Node.js-Script mit `#!/usr/bin/env node`) gespawnt wird → exit code 127.

**Fix:** Alle drei `spawn(claudeStatus.path, ...)` Calls (Orchestrator, Memory, Agents) erhalten jetzt explizites PATH-Env:
```typescript
env: {
  ...process.env,
  PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
    .filter(Boolean).join(':'),
}
```

## EmailMC Ordner-Navigation (v1.1.11)

IMAP-Unterordner werden jetzt geladen und können gewechselt werden.

**Neuer IPC Handler:** `list-mail-folders` – sendet `LIST "" "*"` nach Login, parst alle Ordnernamen
**Preload:** `listMailFolders(account)`
**UI:** Ordner-Dropdown unter der Suchleiste (erscheint nach Account-Auswahl)
**Logik:**
- `selectAccount()` lädt Ordnerliste im Hintergrund nach dem ersten Laden
- `loadMessages(acc, folder)` – separate Funktion, nimmt Ordner-Parameter
- `selectFolder(name)` – wechselt Ordner + lädt Nachrichten neu

## App-Crash Fix: EPIPE (v1.1.10)

### Ursache
`Error: write EPIPE` im Main Process wenn Orchestrator oder Ollama noch streamen während der Nutzer das Tab wechselt oder die Konversation abbricht. Node.js wirft EPIPE wenn in eine geschlossene IPC-Pipe geschrieben wird → unkontrollierter Crash der ganzen App (Dialog "A JavaScript error occurred in the main process").

### Fixes
1. **Globaler EPIPE-Handler** (direkt nach App-Start):
   ```typescript
   process.on('uncaughtException', (err) => {
     if (err.code === 'EPIPE') return; // silently ignore
     console.error('[Main] Uncaught exception:', err);
   });
   ```
2. **Orchestrator-Streaming** (`orchestrator-chunk` Events): alle `event.sender.send()` in try-catch
3. **Ollama-Streaming** (`ollama-chunk` Events): alle `event.sender.send()` in try-catch

**Betroffene Datei:** `src/main/index.ts`

## OAuth2 login_hint Fix (v1.1.9)

### NoADRecipient durch falschen Token-Account
**Ursache:** Die OAuth2-Auth-URL hatte kein `login_hint`. Wenn der Browser bereits mit einem anderen Account (z.B. Admin) eingeloggt war, wurde das Token für diesen Account ausgestellt. Das XOAUTH2-Kommando sendete aber `user=technik@autosecure.net` → Microsoft: UPN im Token ≠ angeforderter Mailbox-User → `NoADRecipient`.

**Fix:** `login_hint: account.user` in die Auth-URL-Parameter eingefügt. Microsoft zeigt jetzt den Account-Picker mit dem richtigen Account vorausgefüllt und fordert Login als `technik@autosecure.net` an.

**Betroffene Datei:** `src/main/index.ts` – `oauth2-authorize` Handler

**Nach dem Update:** Alten Token widerrufen (🔐 → Token entfernen) und neu anmelden → Browser öffnet direkt für `technik@autosecure.net`.

## Cowork Lock Fixes (v1.1.8)

### Bug 1: Staler Lock nach Arbeit (Push fehlgeschlagen)
**Ursache:** `release-cowork-lock` machte `git push` ohne vorher zu pullen. Wenn der Kollege seit dem Lock-Erstellen neue Commits gepusht hatte, schlug der Push fehl → Lock-Datei lokal gelöscht, aber auf Remote noch vorhanden → Staler Lock sichtbar.

**Fix:** Pull `--rebase --autostash` direkt vor dem Push in `release-cowork-lock` (und `force-release-cowork-lock`).

### Bug 2: Force Unlock nicht möglich
**Ursache:** `force-release-cowork-lock` rief `gitPull` auf, das bei Rebase-Konflikten scheitern kann → gesamter Unlock abgebrochen.

**Fix:** Ersetzt durch `git fetch ${remote} ${branch}` + `git reset --hard FETCH_HEAD`. Synchronisiert exakt auf Remote-Stand ohne Konflikt-Risiko. Push danach immer erfolgreich (genau 1 Commit vor Remote).

### Bug 3: Lock bleibt bei App-Crash
**Ursache:** Kein `before-quit` Handler → wenn App geschlossen/abgestürzt, kein Lock-Cleanup.

**Fix:** `app.on('before-quit', ...)` iteriert über `activeLocks` Map und released alle eigenen Locks synchron (best-effort, blockiert den Quit nicht).

**Betroffene Datei:** `src/main/index.ts`
- `activeLocks = new Map<string, { remote, branch }>()` – trackt aktive Locks
- `create-cowork-lock`: setzt Lock in `activeLocks`
- `release-cowork-lock` / `force-release-cowork-lock`: entfernt aus `activeLocks`, Pull vor Push
- `before-quit` Handler: released alle verbleibenden Locks

## EmailMC OAuth2 Fehlermeldungen (v1.1.7)

### `NoADRecipient` / `AuthResultFromPopImapEnd=8`
Exchange Online meldet diesen Fehler wenn IMAP für die Mailbox deaktiviert ist (Auth erfolgreich, aber Verbindung verweigert).

**Fix (Exchange Admin):**
```powershell
Set-CasMailbox -Identity "user@domain.com" -ImapEnabled $true
# Prüfen:
Get-CasMailbox -Identity "user@domain.com" | Select ImapEnabled
```
Oder: Exchange Admin Center → Empfänger → Postfächer → [Konto] → E-Mail-Apps → IMAP aktivieren.

**Code-Änderung:** `imapLoginError()`-Hilfsfunktion in `src/main/index.ts` erkennt `NoADRecipient` und `AADSTS`-Codes und gibt klare Fehlermeldungen mit Lösungshinweisen zurück (statt rohen IMAP-Fehlern).

## Performance (v1.1.6)

### React + Main Process Optimierungen

**App.tsx:**
- `filteredProjects` → `useMemo` (nur bei `projects`/`searchQuery`-Änderung)
- Settings-Loading → `Promise.all` (alle Projekte parallel statt sequenziell)
- Cowork-Polling-Interval → `useRef`-Pattern (kein Interval-Reset mehr bei Repo-Änderung)
- `lastRefresh` → `useRef` (eliminiert unnötigen Re-Render alle 30s)
- Keyboard-Handler → `useCallback` + Refs (stable reference, kein Stale-Closure-Bug)
- `useMemo` + `useCallback` zu Imports hinzugefügt

**AgentsTab.tsx:**
- `scrollIntoView` → 80ms Debounce (verhindert hunderte Reflows/s beim Streaming)

**OrchestratorTab.tsx:**
- `renderMarkdown` → `useCallback` + module-level Map-Cache (max 200 Einträge)
- Bereits gerenderte Messages werden gecacht statt jedes Mal 8+ Regex-Ops

**index.ts:**
- Agent Output-Buffer → Cap bei 100k Zeichen (Memory-Leak-Prävention)

## EmailMC OAuth2 / O365 Support (v1.1.5)

PKCE-basierter OAuth2-Flow für Office 365 IMAP (Modern Auth).

**Flow:**
1. Azure App Registration anlegen (Public Client, Redirect URI: `http://localhost`)
2. In EmailMC-Konto: Auth-Typ "Office 365 (OAuth2)" wählen, Client ID + Tenant ID eingeben
3. "Anmelden"-Button in der Kontoliste → Browser öffnet Microsoft-Login
4. Nach Login: Access Token + Refresh Token werden in `~/.claude/mail-tokens/{id}.json` gespeichert
5. IMAP-Verbindung nutzt `AUTHENTICATE XOAUTH2` (kein Passwort nötig)

**PKCE (kein Client Secret nötig):**
- `code_verifier` = 32 random bytes (base64url)
- `code_challenge` = SHA-256(verifier) (base64url)
- Lokaler HTTP-Server (zufälliger Port) fängt Redirect ab

**Token-Management:**
- Auto-Refresh wenn Access Token < 60s vor Ablauf
- Revoke-Button (X) in Kontoliste entfernt Token-Datei
- Beim Konto-Löschen wird Token automatisch widerrufen

**Scopes:** `https://outlook.office365.com/IMAP.AccessAsUser.All offline_access`

**Neue IPC Handler:**
- `oauth2-authorize(account)` – PKCE-Flow, öffnet Browser, wartet auf Callback
- `oauth2-get-status(accountId)` – prüft ob Token existiert
- `oauth2-revoke(accountId)` – löscht Token-Datei

**Preload Bridge:** `startOAuth2`, `getOAuth2Status`, `revokeOAuth2`, `onOAuth2Complete`

**Geänderte Dateien:**
- `src/shared/types.ts` – `authType?`, `oauth2ClientId?`, `oauth2TenantId?` auf MailAccount; `OAuth2Tokens` Interface
- `src/main/index.ts` – `crypto` Import, OAuth2-Helpers, 3 neue IPC Handler, XOAUTH2 in IMAP-State-Machines
- `src/main/preload.ts` – 4 neue Bridge-Methoden
- `src/renderer/components/EmailMCPanel.tsx` – AccountModal mit Auth-Typ-Selector, OAuth2-Status + Anmelden-Button in Kontoliste
- `src/renderer/styles/index.css` – `.btn-oauth2-sm`, `.oauth2-badge`, `.oauth2-setup-hint`

**Token-Speicherort:** `~/.claude/mail-tokens/{accountId}.json`

**Korrektes Azure Portal Setup (Single-Tenant):**
1. App registrations → Neue Registrierung
2. "Supported account types": **Single Tenant** (nur eigene Org)
3. Redirect URI: Typ = "Mobile and desktop applications", Wert = `http://localhost`
4. API Permissions → Add a permission → **APIs my organization uses** → "Office 365 Exchange Online" → Delegated → `IMAP.AccessAsUser.All`
5. Tenant ID: Aus Azure AD → Overview → "Directory (tenant) ID" kopieren → im EmailMC-Konto eintragen (NICHT "common")

**Wichtig:** `IMAP.AccessAsUser.All` ist eine Exchange-Online-Permission (nicht Microsoft Graph). Bei Multitenant-App nicht sichtbar → deshalb Single-Tenant verwenden!

**Bekannte Fehler:**

| Fehlercode | Ursache | Lösung |
|---|---|---|
| `AADSTS50194` | Single-Tenant-App nutzt `/common` Endpoint | Eigene Tenant-ID eintragen (statt "common") |
| `AADSTS700016` | Client ID falsch | Application (client) ID aus Azure Portal prüfen |
| `invalid_request` | Redirect URI fehlt | Azure Portal → Authentication → `http://localhost` (Mobile/Desktop) |
| IMAP-Permission fehlt | `IMAP.AccessAsUser.All` nicht in Liste | "APIs my organization uses" → "Office 365 Exchange Online" (nicht Graph!) |

## EmailMC Ollama-Integration (v1.1.4)

Lokales LLM (Ollama) für E-Mail-Analyse und Suche.

**UI (3-Pane Layout):**
- Links: Kontoliste (add/edit/remove)
- Mitte: Nachrichtenliste + semantische Suchleiste
- Rechts: Analyse-Panel (erscheint bei Nachrichtenauswahl)

**Ollama-Features:**
- Status-Dot: grün (erreichbar) / rot (nicht erreichbar) / blinkend (prüft)
- Einstellungen: URL (default: http://localhost:11434) + Modell-Dropdown
- 4 Analyse-Modi (alle streaming):
  - **Zusammenfassung** – max 3 Sätze
  - **Kategorie** – Arbeit/Privat/Newsletter/Spam/... + Priorität
  - **Antwort-Entwurf** – professioneller Entwurf auf Deutsch
  - **Extraktion** – Termine, TODOs, wichtige Zahlen
- **Semantische Suche** via Ollama (Enter → IDs der Treffer zurück → Filter)
- Volltext laden via IMAP `BODY.PEEK[TEXT]` (HTML wird gestrippt)

**IPC Handler:**
- `fetch-mail-body(account, seqNum)` – IMAP Body-Fetch mit Literal-Parser
- `ollama-list-models(url)` – GET /api/tags → Modellnamen
- `ollama-analyze(url, model, system, user)` – Streaming via `ollama-chunk` Event

**Persistenz:** Ollama-URL + Modell in `localStorage`

**Kein Anthropic/Claude API** – ausschließlich lokales Ollama.

## EmailMC / ServerMC (v1.1.3)

### Umbenennung
- AutoMail → **EmailMC** (NavView, CSS-Klassen, Komponente)

### ServerMC (neues Panel)
Server-Monitoring + E-Mail-Inbox in einem Panel.

**Tab "Server":**
- Serverliste aus Deployment-Configs
- Docker-Container-Status via SSH (`docker ps`) beim Klick
- Tabelle: Name | Status | Image | Ports
- IPC Handler: `get-server-docker-status(host, user, sshKeyPath?)`

**Tab "Emails":**
- Kontoliste aus EmailMC-Konfiguration
- IMAP-Inbox read-only (letzten 30 Nachrichten)
- Anzeige: Absender, Betreff, Datum, Gelesen-Status (blauer Punkt)
- Encoded-Word Decoder (=?UTF-8?B/Q?...?=)
- IPC Handler: `fetch-mail-messages(account, limit?)`

**Neue Dateien:**
- `src/renderer/components/ServerMCPanel.tsx`

**Geänderte Dateien:**
- `src/renderer/components/EmailMCPanel.tsx` (umbenannt von AutoMailPanel.tsx)
- `src/renderer/components/NavSidebar.tsx` – `'automail'` → `'emailmc'`, + `'servermc'` mit Server-Icon
- `src/renderer/components/App.tsx` – EmailMCPanel + ServerMCPanel eingebunden
- `src/main/index.ts` – 2 neue IPC Handler + IMAP-Parser-Helpers
- `src/main/preload.ts` – fetchMailMessages, getServerDockerStatus Bridge

## EmailMC (v1.1.2)

IMAP Mail-Konten readonly verknüpfen und Verbindung testen.

**Dateien:**
- `src/renderer/components/AutoMailPanel.tsx` – Panel + AccountModal
- `src/shared/types.ts` – `MailAccount`, `MailMessage`, `MailConnectionResult` Interfaces
- `src/main/index.ts` – IPC Handler (get/save/remove/test-mail-connection)
- `src/main/preload.ts` – Bridge: `getMailAccounts`, `saveMailAccount`, `removeMailAccount`, `testMailConnection`

**Features:**
- Konto hinzufügen (Name, Host, Port, User, Passwort, SSL/TLS, Ordner)
- Verbindungstest: TLS/net Socket → IMAP `* OK` Greeting prüfen
- Konto bearbeiten / entfernen
- Persistenz: `~/.claude/mail-accounts.json`
- Sidebar: Mail-Icon als neuer NavView `'automail'`

**Kein externes npm-Package nötig** – Verbindungstest über Node.js `tls`/`net` Module.

## Performance (v1.0.0)

### Terminal-Typing-Lag + WindowServer-Stutter behoben

**Ursache 1 — Regex-Spam im Main Process:**
`checkForNotificationPatterns()` wurde auf jedem rohen PTY-Chunk aufgerufen (vor dem 8ms-Batching). Beim Claude-Streaming: 21 Regex-Ops/Chunk × hunderte Chunks/Sek. = Event-Loop zu beschäftigt → `pty-write` (Keyboard-Input) kam verzögert an.

**Ursache 2 — Canvas-Renderer belastet WindowServer:**
xterm.js nutzte standardmäßig Canvas-Rendering. Große gebatchte Datenpakete → ein großer Canvas-Render-Frame → WindowServer-Compositing-Spike → visuelles Stottern, das auch andere Electron-Apps (WhatsApp) betraf.

**Ursache 3 — Alle Tabs initialisieren gleichzeitig:**
`tabs.forEach` in `useEffect` erstellte alle xterm-Instanzen und spawnte alle PTYs synchron beim Hinzufügen, egal ob Tab aktiv war.

**Fixes in `src/main/index.ts`:**
- `checkForNotificationPatterns` aus dem rohen `onData`-Handler entfernt
- Wird jetzt im 8ms-Timer auf den gebatchten Daten aufgerufen (max. ~125×/Sek. statt 1000+×/Sek.)
- Auch der Exit-Flush ruft den Pattern-Check auf dem verbleibenden Buffer auf

**Fixes in `src/renderer/components/Terminal.tsx`:**
- **WebGL-Renderer** (`xterm-addon-webgl`): GPU-beschleunigtes Rendering, entlastet WindowServer deutlich
- **Canvas-Fallback**: `onContextLoss` → `webglAddon.dispose()` → Canvas-Renderer bleibt aktiv
- **Lazy Tab Init**: Tabs werden nur initialisiert wenn sie erstmals aktiv werden (`useEffect([activeTabId])`) statt alle gleichzeitig beim Hinzufügen
- Tab-Daten ohne Stale-Closure via `tabsRef` (Ref auf aktuelles `tabs`-Array)

**Neue Abhängigkeit:** `xterm-addon-webgl@^0.16.0`

## Bug-Fix (v0.9.9)

### Terminal abgeschnitten bei Cowork-Tab-Öffnung

**Ursache:** `handlePreFlightProceed` (Cowork "Claude ▶") und `handleRunQuickCommand` riefen kein `setMainView('terminal')` auf. Der Terminal spawnte im versteckten Zustand (`display: none` auf Parent-Div) → `fitAddon.fit()` berechnete 0px → PTY startete mit falschen cols → Terminal dauerhaft abgeschnitten.

**Fixes:**
- `App.tsx`: `setMainView('terminal')` in `handlePreFlightProceed` und `handleRunQuickCommand` ergänzt
- `Terminal.tsx`: Zweiter `fitAddon.fit()`-Pass nach 300ms als Safety-Net (triggert `ptyResize` falls cols beim ersten Fit noch falsch waren)

## Performance (v0.9.8)

### Terminal-Lag bei Texteingabe behoben

**Ursache:** Beim Claude-Streaming gingen hunderte IPC-Nachrichten/Sekunde (`pty-data`) an den Renderer, was den Event-Loop verstopfte und Tastatureingaben verzögerte.

**Fixes in `src/main/index.ts`:**
1. **8ms Output-Batching**: `ptyProcess.onData` puffert nun Daten für 8ms und sendet sie gebündelt via IPC (`ptyDataBuffers`/`ptyDataTimers` Maps)
2. **Buffer-Flush bei Exit**: `onExit` leert den Buffer sofort vor dem `pty-exit` Signal
3. **stripAnsi-Optimierung**: `checkForNotificationPatterns` ruft `stripAnsi()` nur noch auf den neuen Chunk auf (statt den gesamten Akkumulationsbuffer), da der Buffer bereits bereinigt abgelegt wird

**Ergebnis:** Statt 500+ IPC-Nachrichten/Sek. (beim Streaming) maximal ~125/Sek. Tastatureingaben bleiben flüssig.

## Bug-Fixes (v0.9.7)

### Cowork-Lock Polling (30s statt 5min)
- `src/renderer/components/App.tsx`: Interval von `5 * 60 * 1000` auf `30 * 1000` reduziert
- Lock-Status anderer Nutzer erscheint jetzt innerhalb von 30 Sekunden

### Terminal Footer-Überlappung
- `src/renderer/styles/index.css`: `.app-footer` von `position: fixed` zu `flex-shrink: 0` geändert
- `padding-bottom: 28px` auf `.app` entfernt
- Footer ist jetzt normales Flex-Child → Terminal wird nicht mehr abgeschnitten

## Revert (v0.7.72)

Gastown-Integration (v0.7.38–v0.7.71) wurde vollständig entfernt:
- Gastown Multi-Agent Orchestrator IPC Handler entfernt
- Wiki Tab, Mayor Chat Tab, Mayor Terminal entfernt
- GitHubBrowserModal entfernt
- `.beads/`, `crew/`, `daemon/`, `mayor/`, `witness/` Verzeichnisse entfernt
- OpenClaw Integration entfernt
- Zurück zu stabilem Pre-Gastown-Stand (v0.7.38-Codebase)
