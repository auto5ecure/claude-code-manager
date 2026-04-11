# claude-code-manager

<!-- AUTO-GENERATED-START -->
## 📊 Übersicht

| 📄 Dateien | 📁 Ordner | 💾 Größe | 🔄 Commits |
|:----------:|:---------:|:--------:|:----------:|
| 66 | 84 | 187.2 MB | 49 |

**Tech Stack:** `JSON` · `Markdown` · `YAML` · `TypeScript` · `HTML`

## 🌿 Git

| Branch | Status | Letzter Commit |
|--------|--------|----------------|
| `main` | ✅ Clean | 2026-04-07: v0.7.38: git pull --rebase für divergente Branches |

**Contributors:** Timon

## ⚡ Quick Actions

| Aktion | Beschreibung |
|--------|-------------|
| 📂 Finder | `open "/Users/timon/Documents/TimonPrivat_vault/Projekte/claude-code-manager"` |
| 💻 Terminal | `cd "/Users/timon/Documents/TimonPrivat_vault/Projekte/claude-code-manager"` |
| 📝 CLAUDE.md | `code "/Users/timon/Documents/TimonPrivat_vault/Projekte/claude-code-manager/CLAUDE.md"` |

## 📍 Pfad

```
/Users/timon/Documents/TimonPrivat_vault/Projekte/claude-code-manager
```

> Aktualisiert: 2026-04-10 21:16

<!-- AUTO-GENERATED-END -->

## Projektdokumentation (CLAUDE.md)

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


<!-- CHANGELOG-START -->
## Changelog

### 2026-04-10 21:16

**Git Commits**
- v0.7.38: git pull --rebase für divergente Branches
- v0.7.37: Autofix URLs + Löschen-Button Position
- v0.7.35: GitHub URL Normalisierung (Trailing Slash entfernen)
- v0.7.34: Force Unlock Button mit Warnung
- v0.7.33: SSH-Key Pfad Normalisierung für Team-Sharing
- ... und 8 weitere

---


### 2026-04-02 09:14

**Neue Dateien**
- `WIKI.md`
- `claudemc.md`

---


### 2026-04-02 09:14

**Neue Dateien**
- `claudemc.md`

**Git Commits**
- v0.7.22: Wiki-Design überarbeitet
- v0.7.7: Cowork-Repos Pfad-Änderung
- v0.7.7: Pfad-Änderung für Cowork-Repos
- v0.7.6: Projekt-Pfad Erkennung und Änderung
- docs: Update für v0.7.5 (claudemc.md Marker)
- ... und 3 weitere

---


<!-- CHANGELOG-END -->
