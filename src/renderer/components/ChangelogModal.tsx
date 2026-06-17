import { useEffect, useState } from 'react';

interface ChangelogModalProps {
  currentVersion: string;
  lastSeenVersion: string | null;
  onClose: () => void;
}

interface BundledNotes {
  version?: string;
  releaseDate?: string;
  notes?: string;
}

// Split a notes blob into list items. release.sh writes one paragraph per
// release; we treat newlines OR ` · ` separators OR sentence-terminating
// punctuation followed by capitalized phrases as boundaries. Falls back to a
// single bullet so even a one-line release shows up cleanly.
function splitNotesToItems(notes: string): string[] {
  const trimmed = notes.replace(/^v[\d.]+:\s*/, '').trim();
  if (!trimmed) return [];
  // Split on explicit newlines first
  const byNewline = trimmed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  // Split a long single-line blob on " · " separators (used by release.sh)
  const byMid = trimmed.split(/\s*·\s*/).map(s => s.trim()).filter(Boolean);
  if (byMid.length > 1) return byMid;
  return [trimmed];
}

export default function ChangelogModal({ currentVersion, onClose }: ChangelogModalProps) {
  const [bundled, setBundled] = useState<BundledNotes | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await window.electronAPI?.getBundledReleaseNotes?.();
      if (res && !('error' in res && res.error)) setBundled(res);
      setLoading(false);
    })();
  }, []);

  const items = bundled?.notes ? splitNotesToItems(bundled.notes) : [];
  const versionLabel = bundled?.version || currentVersion;
  const dateLabel = bundled?.releaseDate;

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
          {loading ? (
            <p className="changelog-empty">Lade Release Notes …</p>
          ) : items.length === 0 ? (
            <p className="changelog-empty">
              Keine Release Notes verfügbar. Schau auf{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.electronAPI?.openExternal?.('https://github.com/auto5ecure/claude-code-manager/commits/main');
                }}
              >
                GitHub
              </a>{' '}für Details.
            </p>
          ) : (
            <div className="changelog-entry">
              <div className="changelog-version-header">
                <span className="changelog-version">v{versionLabel}</span>
                {dateLabel && <span className="changelog-date">{dateLabel}</span>}
              </div>
              <ul className="changelog-changes">
                {items.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
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
