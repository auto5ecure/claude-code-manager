import { useState, useEffect } from 'react';

interface GitHubRepo {
  name: string;
  fullName: string;
  url: string;
  description?: string;
  private: boolean;
  updatedAt: string;
  defaultBranch: string;
}

interface GitHubBrowserModalProps {
  onClose: () => void;
  onRepoAdded?: () => void;
}

export default function GitHubBrowserModal({ onClose, onRepoAdded }: GitHubBrowserModalProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneStatus, setCloneStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [addAsRig, setAddAsRig] = useState(true);
  const [rigPrefix, setRigPrefix] = useState('');

  useEffect(() => {
    loadRepos();
  }, []);

  async function loadRepos() {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getGithubRepos?.();
      if (result?.error) {
        setError(result.error);
      } else {
        setRepos(result?.repos || []);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'heute';
    if (days === 1) return 'gestern';
    if (days < 7) return `vor ${days} Tagen`;
    if (days < 30) return `vor ${Math.floor(days / 7)} Wochen`;
    return date.toLocaleDateString('de-DE');
  }

  const filteredRepos = repos.filter(repo => {
    const query = searchQuery.toLowerCase();
    return (
      repo.name.toLowerCase().includes(query) ||
      repo.fullName.toLowerCase().includes(query) ||
      (repo.description?.toLowerCase().includes(query) ?? false)
    );
  });

  async function handleClone() {
    if (!selectedRepo) return;

    setCloning(true);
    setCloneStatus(null);

    try {
      // Get the cowork repos directory as default location
      const coworkDir = await window.electronAPI?.getCoworkReposDir?.();
      const targetPath = coworkDir ? `${coworkDir}/${selectedRepo.name}` : null;

      if (!targetPath) {
        setCloneStatus({ success: false, message: 'Kein Zielverzeichnis gefunden' });
        setCloning(false);
        return;
      }

      // Clone the repository
      const cloneResult = await window.electronAPI?.cloneCoworkRepository?.(
        selectedRepo.url,
        targetPath
      );

      if (!cloneResult?.success) {
        setCloneStatus({ success: false, message: cloneResult?.error || 'Clone fehlgeschlagen' });
        setCloning(false);
        return;
      }

      // Add as project
      const project = await window.electronAPI?.addProjectByPath?.(targetPath);
      if (!project) {
        setCloneStatus({ success: false, message: 'Projekt konnte nicht hinzugefügt werden' });
        setCloning(false);
        return;
      }

      // Optionally add as Gastown rig
      if (addAsRig && rigPrefix) {
        const rigName = selectedRepo.name.replace(/-/g, '_');
        await window.electronAPI?.addRig?.(targetPath, rigName, rigPrefix);
      }

      setCloneStatus({
        success: true,
        message: addAsRig && rigPrefix
          ? `${selectedRepo.name} als Projekt und Rig hinzugefügt`
          : `${selectedRepo.name} als Projekt hinzugefügt`
      });

      onRepoAdded?.();

      // Close modal after a brief delay
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setCloneStatus({ success: false, message: (err as Error).message });
    }

    setCloning(false);
  }

  function selectRepo(repo: GitHubRepo) {
    setSelectedRepo(repo);
    setRigPrefix(repo.name.substring(0, 2).toLowerCase());
    setCloneStatus(null);
  }

  return (
    <div className="github-browser-overlay" onClick={onClose}>
      <div className="github-browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="github-browser-header">
          <h2>GitHub Repositories</h2>
          <button className="github-browser-close" onClick={onClose}>✕</button>
        </div>

        <div className="github-browser-search">
          <input
            type="text"
            placeholder="Suchen..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="github-search-input"
          />
          <button
            className="github-refresh-btn"
            onClick={loadRepos}
            disabled={loading}
          >
            {loading ? '...' : '↻'}
          </button>
        </div>

        <div className="github-browser-content">
          {loading ? (
            <div className="github-loading">Lade Repositories...</div>
          ) : error ? (
            <div className="github-error">
              <span className="error-icon">⚠</span>
              <span>{error}</span>
              <p className="error-hint">
                Stelle sicher, dass gh CLI installiert und eingeloggt ist:<br />
                <code>gh auth login</code>
              </p>
            </div>
          ) : (
            <div className="github-repos-list">
              {filteredRepos.length === 0 ? (
                <div className="github-no-repos">Keine Repositories gefunden</div>
              ) : (
                filteredRepos.map((repo) => (
                  <div
                    key={repo.fullName}
                    className={`github-repo-item ${selectedRepo?.fullName === repo.fullName ? 'selected' : ''}`}
                    onClick={() => selectRepo(repo)}
                  >
                    <div className="repo-header">
                      <span className="repo-name">{repo.name}</span>
                      {repo.private && <span className="repo-private">privat</span>}
                    </div>
                    <div className="repo-owner">{repo.fullName.split('/')[0]}</div>
                    {repo.description && (
                      <div className="repo-description">{repo.description}</div>
                    )}
                    <div className="repo-meta">
                      <span className="repo-branch">{repo.defaultBranch}</span>
                      <span className="repo-updated">{formatDate(repo.updatedAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {selectedRepo && (
          <div className="github-browser-actions">
            <div className="clone-options">
              <label className="clone-option">
                <input
                  type="checkbox"
                  checked={addAsRig}
                  onChange={(e) => setAddAsRig(e.target.checked)}
                />
                <span>Als Gastown Rig hinzufügen</span>
              </label>
              {addAsRig && (
                <input
                  type="text"
                  placeholder="Prefix"
                  value={rigPrefix}
                  onChange={(e) => setRigPrefix(e.target.value.toLowerCase().substring(0, 3))}
                  maxLength={3}
                  className="rig-prefix-input-small"
                />
              )}
            </div>

            {cloneStatus && (
              <div className={`clone-status ${cloneStatus.success ? 'success' : 'error'}`}>
                {cloneStatus.success ? '✅' : '❌'} {cloneStatus.message}
              </div>
            )}

            <button
              className="btn-clone"
              onClick={handleClone}
              disabled={cloning}
            >
              {cloning ? '⏳ Klone...' : `📥 ${selectedRepo.name} klonen`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
