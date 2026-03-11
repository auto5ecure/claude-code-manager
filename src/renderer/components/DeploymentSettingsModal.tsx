import { useState, useEffect } from 'react';
import type { DeploymentConfig } from '../../shared/types';

interface DeploymentSettingsModalProps {
  config: DeploymentConfig;
  onClose: () => void;
  onSave: (config: DeploymentConfig) => void;
  onDelete: (config: DeploymentConfig) => void;
  onTestConnection: (host: string, user: string, sshKeyPath?: string) => Promise<{ success: boolean; error?: string }>;
}

export default function DeploymentSettingsModal({
  config,
  onClose,
  onSave,
  onDelete,
  onTestConnection,
}: DeploymentSettingsModalProps) {
  const [formData, setFormData] = useState<DeploymentConfig>(config);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setFormData(config);
    setHasChanges(false);
    setConnectionResult(null);
  }, [config]);

  function handleChange(section: 'server' | 'urls' | 'docker' | 'root', field: string, value: string) {
    setHasChanges(true);
    setConnectionResult(null);

    if (section === 'root') {
      setFormData(prev => ({ ...prev, [field]: value }));
    } else {
      setFormData(prev => ({
        ...prev,
        [section]: { ...prev[section], [field]: value }
      }));
    }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setConnectionResult(null);

    try {
      const result = await onTestConnection(
        formData.server.host,
        formData.server.user,
        formData.server.sshKeyPath
      );
      setConnectionResult(result);
    } catch (err) {
      setConnectionResult({ success: false, error: (err as Error).message });
    } finally {
      setTestingConnection(false);
    }
  }

  function handleSave() {
    onSave(formData);
    onClose();
  }

  function handleDelete() {
    if (confirm(`Deployment-Konfiguration "${config.name}" wirklich löschen?`)) {
      onDelete(config);
      onClose();
    }
  }

  return (
    <div className="deployment-settings-modal-overlay" onClick={onClose}>
      <div className="deployment-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="deployment-settings-header">
          <span>Deployment Einstellungen</span>
          <button className="deployment-settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="deployment-settings-content">
          {/* General */}
          <div className="settings-section">
            <h3>Allgemein</h3>
            <div className="settings-field">
              <label>Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => handleChange('root', 'name', e.target.value)}
                placeholder="Projektname"
              />
            </div>
            <div className="settings-field">
              <label>Projektpfad</label>
              <input
                type="text"
                value={formData.projectPath}
                disabled
                className="disabled"
              />
            </div>
          </div>

          {/* Server */}
          <div className="settings-section">
            <h3>Server</h3>
            <div className="settings-row">
              <div className="settings-field">
                <label>Host</label>
                <input
                  type="text"
                  value={formData.server.host}
                  onChange={(e) => handleChange('server', 'host', e.target.value)}
                  placeholder="z.B. 192.168.1.100"
                />
              </div>
              <div className="settings-field small">
                <label>User</label>
                <input
                  type="text"
                  value={formData.server.user}
                  onChange={(e) => handleChange('server', 'user', e.target.value)}
                  placeholder="root"
                />
              </div>
            </div>
            <div className="settings-field">
              <label>SSH Key Pfad</label>
              <input
                type="text"
                value={formData.server.sshKeyPath || ''}
                onChange={(e) => handleChange('server', 'sshKeyPath', e.target.value)}
                placeholder="~/.ssh/id_ed25519 (leer = Standard-Key)"
              />
              <span className="field-hint">Leer lassen für Standard SSH-Key</span>
            </div>
            <div className="settings-field">
              <label>Remote Verzeichnis</label>
              <input
                type="text"
                value={formData.server.directory}
                onChange={(e) => handleChange('server', 'directory', e.target.value)}
                placeholder="/opt/projekt"
              />
            </div>

            <div className="settings-test-connection">
              <button
                className={`test-connection-btn ${testingConnection ? 'testing' : ''}`}
                onClick={handleTestConnection}
                disabled={testingConnection || !formData.server.host || !formData.server.user}
              >
                {testingConnection ? 'Teste...' : 'Verbindung testen'}
              </button>
              {connectionResult && (
                <span className={`connection-result ${connectionResult.success ? 'success' : 'error'}`}>
                  {connectionResult.success ? '✓ Verbindung erfolgreich' : `✗ ${connectionResult.error}`}
                </span>
              )}
            </div>
          </div>

          {/* URLs */}
          <div className="settings-section">
            <h3>URLs</h3>
            <div className="settings-field">
              <label>Production URL</label>
              <input
                type="text"
                value={formData.urls.production}
                onChange={(e) => handleChange('urls', 'production', e.target.value)}
                placeholder="https://example.com"
              />
            </div>
            <div className="settings-field">
              <label>Health Check Pfad</label>
              <input
                type="text"
                value={formData.urls.health}
                onChange={(e) => handleChange('urls', 'health', e.target.value)}
                placeholder="/health"
              />
            </div>
          </div>

          {/* Docker */}
          <div className="settings-section">
            <h3>Docker</h3>
            <div className="settings-field">
              <label>Image Name</label>
              <input
                type="text"
                value={formData.docker.imageName}
                onChange={(e) => handleChange('docker', 'imageName', e.target.value)}
                placeholder="my-app"
              />
            </div>
            <div className="settings-field">
              <label>Dockerfile Pfad</label>
              <input
                type="text"
                value={formData.docker.dockerfile}
                onChange={(e) => handleChange('docker', 'dockerfile', e.target.value)}
                placeholder="Dockerfile"
              />
            </div>
            <div className="settings-field">
              <label>Container Name</label>
              <input
                type="text"
                value={formData.docker.containerName}
                onChange={(e) => handleChange('docker', 'containerName', e.target.value)}
                placeholder="my-app-container"
              />
            </div>
          </div>
        </div>

        <div className="deployment-settings-footer">
          <button className="btn-delete" onClick={handleDelete}>
            Löschen
          </button>
          <div className="footer-right">
            <button className="btn-cancel" onClick={onClose}>
              Abbrechen
            </button>
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={!hasChanges}
            >
              Speichern
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
