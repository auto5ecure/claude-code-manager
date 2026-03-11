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
