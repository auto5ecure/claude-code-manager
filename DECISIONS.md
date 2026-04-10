# DECISIONS

Append-only log. Format: YYYY-MM-DD — Decision — Reason

---

2026-03-02 — Electron + React + TypeScript — Standard desktop stack, good DX, cross-platform
2026-03-02 — Vite for bundling — Fast HMR, native ESM, simpler than webpack
2026-03-02 — Main/Renderer/Shared structure — Clean separation of concerns for Electron

2026-03-11 — Coworking-Feature für Team-Kollaboration — Ermöglicht gemeinsames Arbeiten an GitHub-Repos mit Claude Code
2026-03-11 — Pre-Flight Check vor Claude-Sessions — Stellt sicher dass Repo aktuell ist, verhindert Konflikte
2026-03-11 — .cowork.lock Datei im Repo — Signalisiert anderen Usern dass jemand arbeitet, wird mit Git synchronisiert
2026-03-11 — Lock-Timeout von 2 Stunden — Ermöglicht Force-Unlock bei vergessenen Locks
2026-03-11 — Auto-Refresh alle 5 Minuten — Hält Sync-Status aktuell ohne manuelle Aktion
2026-03-11 — Notification-Banner für Behind-Status — Auffällige Warnung wenn Kollegen gepusht haben
2026-03-11 — Automatisches Klonen in {userData}/repos/ — Standardisierter Speicherort, kein manuelles Setup nötig
2026-03-11 — Lock wird bei Session-Start committed+pushed — Andere sehen sofort dass jemand arbeitet
2026-03-11 — Kein Branch-per-User — Für kleine Teams (2-3) ist main-Branch mit häufigem Pull/Push einfacher
2026-03-11 — Tab-Close Hook für automatischen Lock-Release — Bei Tab-Schließung wird Commit-Modal angezeigt und Lock automatisch freigegeben
2026-03-11 — Auto-Detect von Branch und Remote — Branch/Remote werden automatisch vom lokalen Repo erkannt, keine manuelle Eingabe nötig
2026-03-11 — Deployment-Feature für Server-Releases — Ein-Klick-Deployment mit SSH, Docker Build, Health Check und Rollback
2026-03-11 — Deployment in Cowork integriert — Deployment-Optionen erscheinen direkt bei Cowork-Repos statt als separate Sektion
2026-03-11 — Deployment-Config pro Projekt (.deployment.json) — Config liegt im Projekt-Root, kann mit Repo geteilt werden
2026-03-11 — Import/Export für Deployment-Configs — JSON-Export zum Teilen, Import erkennt passende Projekte automatisch
2026-03-11 — Auto-Updater via Nextcloud WebDAV — Nutzt Public Share mit Basic Auth, kein eigener Update-Server nötig
2026-03-11 — Version-Check beim App-Start — Automatische Prüfung ohne User-Interaktion, Update wird angeboten
2026-03-11 — Auto-Install auf macOS — DMG wird automatisch gemountet, App nach /Applications kopiert, App neu gestartet
2026-03-11 — CoworkSettingsModal für Import/Export — Zentrales Zahnrad-Icon statt mehrerer Buttons, bessere UX
2026-03-11 — Release-Prozess dokumentiert — Version in package.json, npm run dist, Upload zu Nextcloud, version.json update
2026-03-11 — Changelog Modal nach Updates — Zeigt einmalig neue Features nach Version-Update, gespeichert in localStorage
2026-03-11 — SSH-Key Auto-Discovery — Sucht automatisch nach verfügbaren SSH-Keys wenn konfigurierter Key nicht existiert
2026-03-11 — SSH-Key Import in Settings — Plus-Button zum Importieren von SSH-Keys per Datei oder Text-Eingabe
2026-03-11 — Update fragt vor Installation — Kein Auto-Install mehr, damit laufende Sessions nicht unterbrochen werden
2026-03-12 — Docker Build Timeout auf 5 Minuten — SSH-Timeout war zu kurz (30s) für Docker Builds
2026-03-12 — Code Signing mit Developer ID — App wird von autosecure GmbH signiert, öffnet ohne Gatekeeper-Warnung
2026-03-12 — Apple Notarization — App wird bei Apple zur Prüfung eingereicht, erhält Notarization Ticket
2026-03-12 — Build nach /tmp statt release/ — Desktop-Dateisystem hatte Resource Fork Probleme beim Signieren
2026-03-12 — Hardened Runtime aktiviert — Erforderlich für Notarization, mit JIT und unsigned memory Entitlements für Electron
2026-03-14 — .deployment.json in .gitignore — Maschinenspezifische Pfade (SSH-Keys, projectPath), jeder User braucht eigene Config
2026-03-16 — Force Unlock immer sichtbar — Button erscheint bei jedem Lock, nicht nur bei stale Locks (>2h)
2026-03-16 — Deployment Setup Button — "🚀 Deployment einrichten" erscheint wenn keine .deployment.json existiert
2026-03-16 — Docker DEPRECATED Warning Filter — Build-Warnungen werden rausgefiltert, nur echte Fehler werden angezeigt
2026-03-16 — Import/Export im Deployment Settings Modal — Pro-Projekt Import/Export statt global, bessere UX
2026-04-10 — Gastown UI Integration — Claude MC als UI für Gastown Multi-Agent Orchestrator, Rig-Status pro Projekt
2026-04-10 — Tags in CLAUDE.md Header — Context/Template/Tags als HTML-Kommentare, nicht-invasiv für Cowork-Partner ohne Gastown
2026-04-10 — Rig-Registrierung lokal — ~/gt/rigs/ ist lokal, wird nicht ins Git committed
2026-04-10 — GitHub Repos Browser — GH Button in Sidebar, Repos via gh CLI laden, Clone + Rig in einem Schritt
