# Claude Code Manager

Electron-basierte Desktop-Anwendung zur Verwaltung von Claude Code Projekten.

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
