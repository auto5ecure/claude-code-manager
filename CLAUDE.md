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
