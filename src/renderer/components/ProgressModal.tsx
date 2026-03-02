interface ProgressModalProps {
  title: string;
  steps: string[];
  currentStep: number;
  completed?: boolean;
  statusText?: string;
  changes?: string[];
  summary?: {
    projectName: string;
    newType: string;
    templateSize: number;
  };
  onClose?: () => void;
}

export default function ProgressModal({
  title, steps, currentStep, completed, statusText, changes, summary, onClose
}: ProgressModalProps) {
  const progress = completed ? 100 : ((currentStep + 1) / steps.length) * 100;

  return (
    <div className="progress-overlay">
      <div className="progress-modal">
        <div className="progress-title">{completed ? 'Transformation abgeschlossen' : title}</div>
        <div className="progress-bar-container">
          <div className={`progress-bar ${completed ? 'completed' : ''}`} style={{ width: `${progress}%` }} />
        </div>

        {/* Live Status */}
        {statusText && !completed && (
          <div className="progress-status">{statusText}</div>
        )}

        {/* Changes Log */}
        {changes && changes.length > 0 && (
          <div className="progress-changes">
            {changes.map((change, index) => (
              <div key={index} className="progress-change-item">{change}</div>
            ))}
          </div>
        )}

        {completed ? (
          <div className="progress-summary">
            <div className="summary-icon">✓</div>
            {summary && (
              <div className="summary-details">
                <div className="summary-row">
                  <span className="summary-label">Projekt:</span>
                  <span className="summary-value">{summary.projectName}</span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">Neuer Typ:</span>
                  <span className={`summary-badge ${summary.newType}`}>
                    {summary.newType === 'tools' ? 'Tools' : 'Projekt'}
                  </span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">CLAUDE.md:</span>
                  <span className="summary-value">{(summary.templateSize / 1024).toFixed(1)} KB</span>
                </div>
              </div>
            )}
            <button className="progress-close-btn" onClick={onClose}>
              Schliessen
            </button>
          </div>
        ) : (
          <div className="progress-steps">
            {steps.map((step, index) => (
              <div
                key={index}
                className={`progress-step ${index < currentStep ? 'done' : ''} ${index === currentStep ? 'active' : ''}`}
              >
                <span className="progress-step-icon">
                  {index < currentStep ? '✓' : index === currentStep ? '⏳' : '○'}
                </span>
                <span className="progress-step-text">{step}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
