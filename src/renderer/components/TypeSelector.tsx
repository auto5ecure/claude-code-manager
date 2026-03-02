interface TypeSelectorProps {
  onSelect: (type: 'tools' | 'projekt') => void;
  onCancel: () => void;
}

export default function TypeSelector({ onSelect, onCancel }: TypeSelectorProps) {
  return (
    <div className="type-selector-overlay" onClick={onCancel}>
      <div className="type-selector-modal" onClick={(e) => e.stopPropagation()}>
        <div className="type-selector-header">
          <span>Projekt-Typ wählen</span>
        </div>
        <div className="type-selector-options">
          <button
            className="type-option projekt"
            onClick={() => onSelect('projekt')}
          >
            <span className="type-option-icon">P</span>
            <div className="type-option-info">
              <span className="type-option-title">Projekt</span>
              <span className="type-option-desc">Staff Repository Engineer Prompt</span>
            </div>
          </button>
          <button
            className="type-option tools"
            onClick={() => onSelect('tools')}
          >
            <span className="type-option-icon">T</span>
            <div className="type-option-info">
              <span className="type-option-title">Tools</span>
              <span className="type-option-desc">Engineering Toolbox Prompt</span>
            </div>
          </button>
        </div>
        <div className="type-selector-footer">
          <button className="type-cancel-btn" onClick={onCancel}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
}
