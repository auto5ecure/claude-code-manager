interface ScreenshotPreviewProps {
  imageData: string;
  projectName: string;
  onSave: () => void;
  onCancel: () => void;
}

export default function ScreenshotPreview({
  imageData,
  projectName,
  onSave,
  onCancel,
}: ScreenshotPreviewProps) {
  return (
    <div className="screenshot-overlay">
      <div className="screenshot-modal">
        <div className="screenshot-header">
          <span>Screenshot für {projectName}</span>
          <button className="close-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="screenshot-image-container">
          <img src={imageData} alt="Screenshot Preview" />
        </div>
        <div className="screenshot-actions">
          <button className="btn-cancel" onClick={onCancel}>Abbrechen</button>
          <button className="btn-save" onClick={onSave}>Speichern</button>
        </div>
      </div>
    </div>
  );
}
