interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.4.5',
    date: '2026-03-14',
    changes: [
      'Merge-Konflikte werden im Pre-Flight Check angezeigt',
      '"Konflikte lösen" Button zum direkten Auflösen',
      'Anzahl der Konflikte wird in der Sidebar gezeigt',
    ],
  },
  {
    version: '0.4.4',
    date: '2026-03-14',
    changes: [
      'Test-Release für Auto-Restart nach Update',
    ],
  },
  {
    version: '0.4.3',
    date: '2026-03-14',
    changes: [
      'Arbeit-beenden Dialog beim Schließen von Cowork-Tabs',
      'Wahl: Lock freigeben, Lock behalten, oder Abbrechen',
      'Fix: App startet nach Update jetzt zuverlässig neu',
    ],
  },
  {
    version: '0.4.2',
    date: '2026-03-14',
    changes: [
      '.cowork.lock erscheint nicht mehr im Commit-Dialog',
      'Lock-Datei wird automatisch vom Lock-System verwaltet',
    ],
  },
  {
    version: '0.4.1',
    date: '2026-03-14',
    changes: [
      'Fix: App startet jetzt automatisch nach Update',
      'Quarantine-Attribut wird entfernt für reibungslosen Start',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-03-14',
    changes: [
      'Fix: Lock-System synct jetzt mit GitHub',
      'Korrekter Lock-Status von Kollegen wird angezeigt',
      'Git fetch vor Lock-Check',
    ],
  },
  {
    version: '0.3.9',
    date: '2026-03-14',
    changes: [
      'Bessere Fehlerausgabe bei Docker Build Fehlern',
      'Vollständige dotnet/Docker Fehlermeldung wird angezeigt',
    ],
  },
  {
    version: '0.3.8',
    date: '2026-03-14',
    changes: [
      'Merge-Konflikt Dialog für Coworking',
      'Wahl zwischen lokaler und remote Version',
      'Smart Merge für .deployment.json (sshKeyPath bleibt lokal)',
    ],
  },
  {
    version: '0.3.7',
    date: '2026-03-12',
    changes: [
      'Git Pull behält lokale Änderungen (z.B. .deployment.json)',
      'Auto-Stash bei Pull-Konflikten',
    ],
  },
  {
    version: '0.3.5',
    date: '2026-03-12',
    changes: [
      'App ist jetzt signiert und notarisiert',
      'Keine Gatekeeper-Warnung mehr beim ersten Start',
    ],
  },
  {
    version: '0.2.8',
    date: '2025-03-11',
    changes: [
      'SSH-Key Import Button (+) in Deployment-Einstellungen',
      'Private Key direkt einfügen oder aus Datei importieren',
      'Update fragt jetzt vor Installation (keine Unterbrechung laufender Sessions)',
    ],
  },
  {
    version: '0.2.7',
    date: '2025-03-11',
    changes: [
      'SSH-Key Auto-Discovery - Findet automatisch verfügbare SSH-Keys',
      'Bessere Fehlermeldungen bei SSH-Problemen',
      'Unterstützung für Team-Deployment ohne Key-Sharing',
    ],
  },
  {
    version: '0.2.6',
    date: '2025-03-11',
    changes: [
      'Changelog Modal - Zeigt Neuerungen nach Updates',
      'Einmalige Anzeige pro Version',
    ],
  },
  {
    version: '0.2.5',
    date: '2025-03-11',
    changes: [
      'Test-Release für Auto-Install',
    ],
  },
  {
    version: '0.2.4',
    date: '2025-03-11',
    changes: [
      'Auto-Install Feature - Updates werden vollautomatisch installiert',
      'DMG wird automatisch gemountet und App nach /Applications kopiert',
      'App startet nach Update automatisch neu',
    ],
  },
  {
    version: '0.2.3',
    date: '2025-03-11',
    changes: [
      'CoworkSettingsModal - Zentrales Zahnrad-Icon für Import/Export',
      'Übersichtlichere Sidebar ohne einzelne Import/Export Buttons',
    ],
  },
  {
    version: '0.2.2',
    date: '2025-03-11',
    changes: [
      'Auto-Update beim App-Start',
      'Nextcloud WebDAV Integration',
    ],
  },
  {
    version: '0.2.1',
    date: '2025-03-11',
    changes: [
      'Version Display im Footer',
      'Update-Prüfung Button',
    ],
  },
  {
    version: '0.2.0',
    date: '2025-03-11',
    changes: [
      'Deployment-System mit SSH und Docker',
      'Coworking Lock-System',
      'Pre-Flight Checks vor Sessions',
      'Import/Export für Configs',
    ],
  },
];

interface ChangelogModalProps {
  currentVersion: string;
  lastSeenVersion: string | null;
  onClose: () => void;
}

export default function ChangelogModal({ currentVersion, lastSeenVersion, onClose }: ChangelogModalProps) {
  // Filter changelog to show only new entries since last seen version
  const newEntries = CHANGELOG.filter(entry => {
    if (!lastSeenVersion) return true; // Show all if first time
    return compareVersions(entry.version, lastSeenVersion) > 0;
  });

  // If showing after update, only show new entries. Otherwise show all.
  const entriesToShow = lastSeenVersion ? newEntries : CHANGELOG.slice(0, 3);

  return (
    <div className="changelog-modal-overlay" onClick={onClose}>
      <div className="changelog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="changelog-header">
          <div className="changelog-title">
            <span className="changelog-icon">🎉</span>
            <span>Was ist neu in v{currentVersion}</span>
          </div>
          <button className="changelog-close" onClick={onClose}>✕</button>
        </div>

        <div className="changelog-content">
          {entriesToShow.map((entry) => (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-version-header">
                <span className="changelog-version">v{entry.version}</span>
                <span className="changelog-date">{entry.date}</span>
              </div>
              <ul className="changelog-changes">
                {entry.changes.map((change, idx) => (
                  <li key={idx}>{change}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="changelog-footer">
          <button className="btn-primary" onClick={onClose}>
            Verstanden
          </button>
        </div>
      </div>
    </div>
  );
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}
