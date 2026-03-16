import { useState, useEffect } from 'react';
import type { DeploymentConfig } from '../../shared/types';

interface DeploymentSettingsModalProps {
  config?: DeploymentConfig;
  projectPath?: string; // For creating new configs
  onClose: () => void;
  onSave: (config: DeploymentConfig) => void;
  onDelete?: (config: DeploymentConfig) => void;
  onTestConnection: (host: string, user: string, sshKeyPath?: string) => Promise<{ success: boolean; error?: string }>;
}

function createDefaultConfig(projectPath: string): DeploymentConfig {
  const projectName = projectPath.split('/').pop() || 'Neues Projekt';
  return {
    id: projectPath.replace(/\//g, '-'),
    name: projectName,
    projectPath,
    server: {
      host: '',
      user: 'root',
      sshKeyPath: '',
      directory: '/opt/' + projectName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    },
    urls: {
      production: '',
      health: '/health',
    },
    docker: {
      imageName: projectName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      dockerfile: 'Dockerfile',
      containerName: projectName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-web',
    },
  };
}

export default function DeploymentSettingsModal({
  config,
  projectPath,
  onClose,
  onSave,
  onDelete,
  onTestConnection,
}: DeploymentSettingsModalProps) {
  const isNewConfig = !config;
  const initialConfig = config || createDefaultConfig(projectPath || '');
  const [formData, setFormData] = useState<DeploymentConfig>(initialConfig);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [showKeyImport, setShowKeyImport] = useState(false);
  const [keyContent, setKeyContent] = useState('');
  const [keyName, setKeyName] = useState('deploy_key');
  const [keyImportError, setKeyImportError] = useState<string | null>(null);
  const [keyImportSuccess, setKeyImportSuccess] = useState<string | null>(null);
  const [importExportMessage, setImportExportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setFormData(config || createDefaultConfig(projectPath || ''));
    setHasChanges(isNewConfig); // New configs always have "changes"
    setConnectionResult(null);
  }, [config, projectPath, isNewConfig]);

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
    if (config && onDelete && confirm(`Deployment-Konfiguration "${config.name}" wirklich löschen?`)) {
      onDelete(config);
      onClose();
    }
  }

  async function handleImportKeyFromFile() {
    setKeyImportError(null);
    setKeyImportSuccess(null);
    try {
      const result = await window.electronAPI?.importSshKey();
      if (result?.success && result.keyPath) {
        handleChange('server', 'sshKeyPath', result.keyPath);
        setKeyImportSuccess(`Key importiert: ${result.keyPath}`);
        setTimeout(() => {
          setShowKeyImport(false);
          setKeyImportSuccess(null);
        }, 1500);
      } else if (result?.error) {
        setKeyImportError(result.error);
      }
    } catch (err) {
      setKeyImportError((err as Error).message);
    }
  }

  async function handleSaveKeyFromText() {
    setKeyImportError(null);
    setKeyImportSuccess(null);

    if (!keyContent.trim()) {
      setKeyImportError('Bitte Key-Inhalt eingeben');
      return;
    }
    if (!keyName.trim()) {
      setKeyImportError('Bitte Key-Namen eingeben');
      return;
    }

    try {
      const result = await window.electronAPI?.saveSshKey(keyContent, keyName);
      if (result?.success && result.keyPath) {
        handleChange('server', 'sshKeyPath', result.keyPath);
        setKeyImportSuccess(`Key gespeichert: ${result.keyPath}`);
        setKeyContent('');
        setTimeout(() => {
          setShowKeyImport(false);
          setKeyImportSuccess(null);
        }, 1500);
      } else if (result?.error) {
        setKeyImportError(result.error);
      }
    } catch (err) {
      setKeyImportError((err as Error).message);
    }
  }

  async function handleImportConfig() {
    setImportExportMessage(null);
    try {
      const result = await window.electronAPI?.showOpenDialog({
        title: 'Deployment-Config importieren',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (result?.filePaths && result.filePaths.length > 0) {
        const content = await window.electronAPI?.readFile(result.filePaths[0]);
        if (content) {
          const imported = JSON.parse(content);
          // Keep current projectPath and id, import the rest
          setFormData(prev => ({
            ...imported,
            id: prev.id,
            projectPath: prev.projectPath,
          }));
          setHasChanges(true);
          setImportExportMessage({ type: 'success', text: 'Config importiert - Speichern nicht vergessen!' });
        }
      }
    } catch (err) {
      setImportExportMessage({ type: 'error', text: `Import fehlgeschlagen: ${(err as Error).message}` });
    }
  }

  async function handleExportConfig() {
    setImportExportMessage(null);
    try {
      const result = await window.electronAPI?.showSaveDialog({
        title: 'Deployment-Config exportieren',
        defaultPath: `deployment-${formData.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result?.filePath) {
        // Export without projectPath (it's machine-specific)
        const exportData = { ...formData };
        delete (exportData as any).projectPath;
        delete (exportData as any).id;
        await window.electronAPI?.writeFile(result.filePath, JSON.stringify(exportData, null, 2));
        setImportExportMessage({ type: 'success', text: 'Config exportiert!' });
      }
    } catch (err) {
      setImportExportMessage({ type: 'error', text: `Export fehlgeschlagen: ${(err as Error).message}` });
    }
  }

  return (
    <div className="deployment-settings-modal-overlay" onClick={onClose}>
      <div className="deployment-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="deployment-settings-header">
          <span>{isNewConfig ? 'Deployment einrichten' : 'Deployment Einstellungen'}</span>
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
              <div className="input-with-button">
                <input
                  type="text"
                  value={formData.server.sshKeyPath || ''}
                  onChange={(e) => handleChange('server', 'sshKeyPath', e.target.value)}
                  placeholder="~/.ssh/id_ed25519 (leer = Auto-Suche)"
                />
                <button
                  type="button"
                  className="input-add-btn"
                  onClick={() => setShowKeyImport(true)}
                  title="SSH Key importieren"
                >
                  +
                </button>
              </div>
              <span className="field-hint">Leer lassen = automatische Key-Suche</span>
            </div>

            {showKeyImport && (
              <div className="key-import-section">
                <div className="key-import-header">
                  <h4>SSH Private Key importieren</h4>
                  <button className="key-import-close" onClick={() => setShowKeyImport(false)}>✕</button>
                </div>

                <div className="key-import-options">
                  <button className="key-import-file-btn" onClick={handleImportKeyFromFile}>
                    📁 Datei auswählen
                  </button>
                  <span className="key-import-or">oder</span>
                </div>

                <div className="key-import-paste">
                  <div className="key-import-name-field">
                    <label>Key-Name:</label>
                    <input
                      type="text"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      placeholder="deploy_key"
                    />
                  </div>
                  <textarea
                    value={keyContent}
                    onChange={(e) => setKeyContent(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----"
                    rows={6}
                  />
                  <button className="key-import-save-btn" onClick={handleSaveKeyFromText}>
                    Key speichern
                  </button>
                </div>

                {keyImportError && (
                  <div className="key-import-error">{keyImportError}</div>
                )}
                {keyImportSuccess && (
                  <div className="key-import-success">{keyImportSuccess}</div>
                )}
              </div>
            )}
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

          {/* Import/Export */}
          <div className="settings-section">
            <h3>Import / Export</h3>
            <div className="import-export-actions">
              <button className="import-export-btn" onClick={handleImportConfig}>
                ⬇ Config importieren
              </button>
              <button className="import-export-btn" onClick={handleExportConfig}>
                ⬆ Config exportieren
              </button>
            </div>
            {importExportMessage && (
              <div className={`import-export-message ${importExportMessage.type}`}>
                {importExportMessage.text}
              </div>
            )}
          </div>
        </div>

        <div className="deployment-settings-footer">
          {!isNewConfig && onDelete && (
            <button className="btn-delete" onClick={handleDelete}>
              Löschen
            </button>
          )}
          <div className="footer-right">
            <button className="btn-cancel" onClick={onClose}>
              Abbrechen
            </button>
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={!hasChanges || !formData.server.host}
            >
              {isNewConfig ? 'Erstellen' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
