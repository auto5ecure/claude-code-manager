# TASK 002: Gastown Integration

## Objective
Claude MC als UI + Gastown als Orchestrator vereinen. Obsidian Wiki ersetzen durch integriertes Wiki das Gastown visualisiert.

## Architektur

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAC (lokal)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  CLAUDE MC (UI)                                         │   │
│  │  • Projekte verwalten (~/Documents/...)                 │   │
│  │  • Terminal (lokale Arbeit)                             │   │
│  │  • Cowork + Locks                                       │   │
│  │  • Deployment                                           │   │
│  │  • [NEU] Wiki Tab (liest ~/gt/)                         │   │
│  │  • [NEU] Mayor Tab (Chat)                               │   │
│  │  • [NEU] Secrets (iCloud Keychain via APW)              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  GASTOWN (~/gt/)                                        │   │
│  │  • Mayor (Orchestrator)                                 │   │
│  │  • Hooks (Templates: Tools/Projekt + STEP 0)            │   │
│  │  • Beads (Issues/Tasks)                                 │   │
│  │  • Rigs (eigene Git-Kopien der Projekte)                │   │
│  │  • Respektiert .cowork.lock                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WireGuard VPN
                            │
┌───────────────────────────┴─────────────────────────────────────┐
│                          VM                                     │
├─────────────────────────────────────────────────────────────────┤
│  • WireGuard Server (10.0.0.1)                                  │
│  • Dendrite (Matrix Server)                                     │
│  • Matrix Bot → Bridge zu Mac Mayor                             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ WireGuard VPN
                            │
┌───────────────────────────┴─────────────────────────────────────┐
│                        HANDY                                    │
├─────────────────────────────────────────────────────────────────┤
│  • Element App (Matrix Client)                                  │
│  • WireGuard App                                                │
│  → "Deploy firma-api" → VM → Mac Mayor → Done                   │
└─────────────────────────────────────────────────────────────────┘
```

## Mayor Chat Sync

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Claude MC  │◄───►│    Mayor    │◄───►│   Element   │
│  (Mac)      │     │  (zentral)  │     │  (Handy)    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │              Chat-History             │
       │           ~/gt/.mayor-chat.db         │
       │                   │                   │
       └───────────────────┴───────────────────┘
                     Sync via
                    WebSocket
```

Beide Interfaces (Claude MC + Element) zeigen dieselbe Chat-History.
Nachrichten werden mit Source markiert: 📱 Element / 💻 Claude MC

## Git-Sync Konzept

```
GitHub/GitLab
     │
     ├─────────────────────────────┐
     │                             │
     ▼                             ▼
┌─────────────┐   git push/pull  ┌─────────────┐
│ Gastown     │◄────────────────►│ Claude MC   │
│ ~/gt/rigs/  │                  │ ~/Documents │
│ (Mayor)     │                  │ (Terminal)  │
└─────────────┘                  └─────────────┘
```

Gastown arbeitet mit **eigenen Git-Kopien** in ~/gt/rigs/.
Sync mit lokalen Projekten über Git push/pull.

## Phasen

### ═══════════════════════════════════════════════════════════
### KERN - Gastown lokal (JETZT)
### ═══════════════════════════════════════════════════════════

### Phase 1: Gastown Setup
- [ ] `brew install gastown`
- [ ] `gt install ~/gt --git`
- [ ] Projekte als Rigs hinzufügen: `gt rig add name https://github.com/...`
- [ ] Crew anlegen: `gt crew add timon`
- [ ] Mayor testen: `gt mayor attach`

### Phase 2: Templates → Mayor Hooks
- [ ] `~/gt/hooks/step0.md` - STEP 0 Pflicht
- [ ] `~/gt/hooks/output-contract.md` - Output Format
- [ ] `~/gt/hooks/mode-tools.md` - Tools Template
- [ ] `~/gt/hooks/mode-projekt.md` - Projekt Template

### Phase 3: Tag-System
- [ ] Tag-Format in CLAUDE.md Header:
  ```markdown
  <!-- CONTEXT: autosecure -->
  <!-- TEMPLATE: tools -->
  <!-- TAGS: backend, python, docker, vpn, hikvision -->
  ```
- [ ] Tag-Kategorien:
  - `context`: privat, autosecure, TimonEsserIT
  - `tech`: python, typescript, react, docker
  - `type`: website, backend, desktop-app, cli
  - `infra`: vpn, ssl, aws, kubernetes
  - `hardware`: hikvision, unifi, synology
  - `features`: auth, deployment, api, security

### Phase 4: Lock-Respekt
- [ ] Mayor-Hook: Check `.cowork.lock` vor Arbeit an Cowork-Repos
- [ ] Normale Projekte: kein Lock-Check

### ═══════════════════════════════════════════════════════════
### ERWEITERUNG - Claude MC Features (DANACH)
### ═══════════════════════════════════════════════════════════

### Phase 5a: Gastown UI Integration in Claude MC
- [ ] IPC Handler für Gastown:
  - `get-gastown-status` - Ist ~/gt/ installiert?
  - `get-rig-status` - Ist Projekt ein Rig?
  - `add-rig` - Projekt als Rig registrieren
  - `get-github-repos` - Repos von GitHub laden
- [ ] Pro Projekt in Sidebar/Modal:
  - Gastown Rig-Status anzeigen (● Rig / ○ Nicht registriert)
  - "Als Rig hinzufügen" Button
  - Beads-Count + Witness-Status
- [ ] Context/Tags Editor:
  - CLAUDE.md Header bearbeiten
  - Context Dropdown (privat/autosecure/TimonEsserIT)
  - Tags hinzufügen/entfernen
- [ ] GitHub Repos Browser:
  - Repos von allen Accounts laden (gh CLI)
  - Neues Repo als Projekt + Rig hinzufügen
  - Clone + Adopt in einem Schritt

### Phase 5b: Wiki Tab in Claude MC
- [ ] Neuer Tab: Wiki
- [ ] Liest ~/gt/ direkt:
  - `~/gt/rigs/` → Projekt-Übersicht
  - `~/gt/.beads/` → Tasks/Issues
  - `~/gt/hooks/` → Mayor Memory
  - `CLAUDE.md` pro Rig → Tags extrahieren
- [ ] Filter nach Context + Tags
- [ ] Skills-Übersicht (aus Tags aggregiert)
- [ ] Obsidian Wiki-Code entfernen (~500 Zeilen)

### Phase 6: Mayor Chat in Claude MC (lokal)
- [ ] Neuer Tab: Mayor Chat
- [ ] Chat-UI (nicht nur Terminal)
- [ ] Chat-History persistent in `~/gt/.mayor-chat.db`
- [ ] Context-Filter Dropdown (Alle / privat / autosecure / TimonEsserIT)
- [ ] Quick Actions: "Status?" "Beads?" "Deploy..."

### Phase 7: Secrets (iCloud Keychain)
- [ ] APW CLI: `brew install apw`
- [ ] Secrets-Referenz in CLAUDE.md: `<!-- SECRETS: projekt/key-name -->`
- [ ] Wiki Tab zeigt Secrets pro Projekt
- [ ] Mayor nutzt `apw get` für Deployments

### ═══════════════════════════════════════════════════════════
### REMOTE - VPN + Messenger (SPÄTER)
### ═══════════════════════════════════════════════════════════

### Phase 8: WireGuard VPN
- [ ] WireGuard auf VM installieren (Server, 10.0.0.1)
- [ ] WireGuard auf Mac (Client, 10.0.0.2)
- [ ] WireGuard auf Handy (Client, 10.0.0.3)

### Phase 9: Matrix Server + Bot
- [ ] Dendrite (Matrix Server) auf VM
- [ ] Matrix Bot (matrix-js-sdk oder maubot)
- [ ] Bot empfängt Element-Nachrichten
- [ ] Leitet via VPN an Mac Mayor weiter

### Phase 10: Chat-Sync
- [ ] WebSocket Server auf VM für Sync
- [ ] Bidirektionaler Sync: Claude MC Chat ↔ Element Chat
- [ ] Nachrichten-Format mit Source-Indicator (📱 Element / 💻 Claude MC)
- [ ] Sync-Status Anzeige in Claude MC

## Entscheidungen

| Thema | Entscheidung |
|-------|--------------|
| VPN | WireGuard selbst gehostet auf VM |
| Matrix Server | Dendrite (leichtgewichtig) auf VM |
| Gastown Rigs | Eigene Git-Kopien, Sync via push/pull |
| Wiki | Claude MC liest ~/gt/ direkt |
| Templates | Als Mayor Hooks migrieren |
| Tags | Multi-dimensional (context, tech, type, infra, hardware, features) |
| Messenger | Matrix (Element) via VM Bot |
| Passwörter | iCloud Keychain via APW CLI |
| Obsidian | Wiki-Generierung entfernen |

## Mayor Hooks (Beispiele)

### ~/gt/hooks/step0.md
```markdown
# STEP 0 - IMMER ZUERST

Bei JEDEM Projekt, BEVOR du arbeitest:
1. Lies: .env, CLAUDE.md, CONTEXT.md, DECISIONS.md, STATUS.md, tasks/
2. Verstehe den Kontext bevor du handelst.
```

### ~/gt/hooks/output-contract.md
```markdown
# Output Contract

JEDE Antwort endet mit:
STATUS: DONE | RUNNING | BLOCKED
SKILL_USED: (debugging | refactoring | build-fix | feature | ...)
CHANGED_FILES: file1.ts, file2.ts
NEXT: Was als nächstes passieren soll
```

### ~/gt/hooks/mode-tools.md
```markdown
# Tools Mode (Engineering Toolbox)

Aktiviert wenn CLAUDE.md enthält: <!-- TEMPLATE: tools -->

- Deterministisch, keine Experimente
- Direkt ausführen OHNE Approval
- Skills: debugging, refactoring, build-fix, test-fix
```

### ~/gt/hooks/mode-projekt.md
```markdown
# Projekt Mode (Staff Engineering)

Aktiviert wenn CLAUDE.md enthält: <!-- TEMPLATE: projekt -->

- Propose → Wait → Execute
- IMMER erst Plan vorstellen
- Approval abwarten vor Implementierung
```

## Chat-Nachrichtenformat

```typescript
interface MayorChatMessage {
  id: string;
  timestamp: Date;
  source: 'claude-mc' | 'element';
  sender: 'user' | 'mayor';
  content: string;
  metadata?: {
    beads?: string[];      // Referenzierte Beads
    rig?: string;          // Betroffenes Projekt
    status?: 'DONE' | 'RUNNING' | 'BLOCKED';
    skill?: string;        // SKILL_USED
    files?: string[];      // CHANGED_FILES
  };
}
```

Gespeichert in `~/gt/.mayor-chat.db` (SQLite) oder `~/gt/mayor-chat.json`.

## Abhängigkeiten

| Tool | Installation |
|------|--------------|
| Gastown | `brew install gastown` |
| Beads | `brew install beads` |
| APW | `brew install apw` |
| WireGuard | `brew install wireguard-tools` |
| Dendrite | Docker auf VM |

## Status
READY - Konzept finalisiert, bereit für Phase 1

## Priorität
```
JETZT:   Phase 1-4 (Gastown lokal)
DANACH:  Phase 5-7 (Claude MC Features)
SPÄTER:  Phase 8-10 (VPN + Messenger)
```

---
Created: 2026-04-10
Updated: 2026-04-10
