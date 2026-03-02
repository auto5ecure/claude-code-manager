interface InfoModalProps {
  onClose: () => void;
}

export default function InfoModal({ onClose }: InfoModalProps) {
  return (
    <div className="info-overlay" onClick={onClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-header">
          <span className="info-title">Claude Code Manager</span>
          <span className="info-version">v0.1.0</span>
        </div>

        <div className="info-content">
          <p className="info-description">
            Desktop-Anwendung zur Verwaltung von Claude Code Projekten mit integriertem Terminal und typ-basierten Workflows.
          </p>

          <div className="info-section">
            <h3>Projekt-Typen</h3>
            <div className="info-types">
              <div className="info-type">
                <span className="info-type-badge tools">T</span>
                <div>
                  <strong>Tools</strong>
                  <p>Deterministischer Engineering-Modus für Wartung, Debugging und präzise Ausführung.</p>
                </div>
              </div>
              <div className="info-type">
                <span className="info-type-badge projekt">P</span>
                <div>
                  <strong>Projekt</strong>
                  <p>Staff Engineering-Modus für grössere Features mit Planungs- und Genehmigungsworkflow.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="info-section">
            <h3>Dokumentations-Struktur</h3>
            <ul className="info-list">
              <li><code>CLAUDE.md</code> — System-Prompt (wird beim Typ-Wechsel ersetzt)</li>
              <li><code>CONTEXT.md</code> — System-Überblick (max 120 Zeilen)</li>
              <li><code>DECISIONS.md</code> — Entscheidungs-Log (append-only)</li>
              <li><code>STATUS.md</code> — Aktueller Stand</li>
            </ul>
          </div>

          <div className="info-section">
            <h3>Tastenkürzel</h3>
            <div className="info-shortcuts">
              <div className="info-shortcut"><kbd>⌘1-9</kbd> Projekt wählen</div>
              <div className="info-shortcut"><kbd>⌘K</kbd> Suche</div>
              <div className="info-shortcut"><kbd>⌘P</kbd> Quick Commands</div>
              <div className="info-shortcut"><kbd>⌘L</kbd> Activity Log</div>
              <div className="info-shortcut"><kbd>Esc</kbd> Schliessen</div>
            </div>
          </div>
        </div>

        <div className="info-footer">
          <a
            className="info-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open('https://github.com/auto5ecure/claude-code-manager', '_blank');
            }}
          >
            GitHub Repository
          </a>
          <button className="info-close-btn" onClick={onClose}>Schliessen</button>
        </div>
      </div>
    </div>
  );
}
