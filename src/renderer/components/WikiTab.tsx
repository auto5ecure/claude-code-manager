import { useState, useEffect } from 'react';

interface GastownRig {
  name: string;
  path: string;
  prefix: string;
  remote?: string;
  branch?: string;
  beadsCount?: number;
}

interface ProjectTags {
  context?: string;
  template?: string;
  tags?: string[];
}

interface RigWithTags extends GastownRig {
  tags?: ProjectTags;
}

interface WikiTabProps {
  onOpenProject?: (path: string) => void;
}

export default function WikiTab({ onOpenProject }: WikiTabProps) {
  const [rigs, setRigs] = useState<RigWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterContext, setFilterContext] = useState<string>('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Collect all unique tags across all rigs
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allContexts, setAllContexts] = useState<string[]>([]);

  useEffect(() => {
    loadRigs();
  }, []);

  async function loadRigs() {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getGastownRigs?.();
      if (result?.error) {
        setError(result.error);
        setRigs([]);
        return;
      }

      const rigsWithTags: RigWithTags[] = [];
      const contexts = new Set<string>();
      const tags = new Set<string>();

      for (const rig of result?.rigs || []) {
        const rigTags = await window.electronAPI?.getProjectTags?.(rig.path);
        rigsWithTags.push({ ...rig, tags: rigTags });

        if (rigTags?.context) contexts.add(rigTags.context);
        if (rigTags?.tags) rigTags.tags.forEach(t => tags.add(t));
      }

      setRigs(rigsWithTags);
      setAllContexts(Array.from(contexts).sort());
      setAllTags(Array.from(tags).sort());
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  // Filter rigs
  const filteredRigs = rigs.filter(rig => {
    // Context filter
    if (filterContext && rig.tags?.context !== filterContext) return false;

    // Tag filter
    if (filterTag && !rig.tags?.tags?.includes(filterTag)) return false;

    // Search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesName = rig.name.toLowerCase().includes(query);
      const matchesTags = rig.tags?.tags?.some(t => t.toLowerCase().includes(query));
      if (!matchesName && !matchesTags) return false;
    }

    return true;
  });

  // Group rigs by context
  const rigsByContext = filteredRigs.reduce((acc, rig) => {
    const context = rig.tags?.context || 'Ohne Context';
    if (!acc[context]) acc[context] = [];
    acc[context].push(rig);
    return acc;
  }, {} as Record<string, RigWithTags[]>);

  return (
    <div className="wiki-tab">
      <div className="wiki-header">
        <h2>Wiki</h2>
        <button className="wiki-refresh" onClick={loadRigs} disabled={loading}>
          {loading ? '...' : '↻'}
        </button>
      </div>

      <div className="wiki-filters">
        <input
          type="text"
          placeholder="Suchen..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="wiki-search"
        />
        <select
          value={filterContext}
          onChange={(e) => setFilterContext(e.target.value)}
          className="wiki-filter-select"
        >
          <option value="">Alle Contexts</option>
          {allContexts.map(ctx => (
            <option key={ctx} value={ctx}>{ctx}</option>
          ))}
        </select>
        <select
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
          className="wiki-filter-select"
        >
          <option value="">Alle Tags</option>
          {allTags.map(tag => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </select>
      </div>

      {error ? (
        <div className="wiki-error">
          <span className="error-icon">⚠</span>
          <p>{error}</p>
          <p className="error-hint">Ist Gastown installiert? (~/gt/)</p>
        </div>
      ) : loading ? (
        <div className="wiki-loading">Lade Rigs...</div>
      ) : rigs.length === 0 ? (
        <div className="wiki-empty">
          <p>Keine Rigs gefunden</p>
          <p className="empty-hint">Füge Projekte als Rigs hinzu über das Projekt-Info Modal</p>
        </div>
      ) : (
        <div className="wiki-content">
          {/* Stats */}
          <div className="wiki-stats">
            <div className="stat">
              <span className="stat-value">{rigs.length}</span>
              <span className="stat-label">Rigs</span>
            </div>
            <div className="stat">
              <span className="stat-value">{rigs.reduce((sum, r) => sum + (r.beadsCount || 0), 0)}</span>
              <span className="stat-label">Beads</span>
            </div>
            <div className="stat">
              <span className="stat-value">{allTags.length}</span>
              <span className="stat-label">Tags</span>
            </div>
          </div>

          {/* Rigs by Context */}
          {Object.entries(rigsByContext).map(([context, contextRigs]) => (
            <div key={context} className="wiki-context-group">
              <h3 className="wiki-context-title">{context}</h3>
              <div className="wiki-rigs-list">
                {contextRigs.map(rig => (
                  <div
                    key={rig.name}
                    className="wiki-rig-card"
                    onClick={() => onOpenProject?.(rig.path)}
                  >
                    <div className="rig-card-header">
                      <span className="rig-card-prefix">[{rig.prefix}]</span>
                      <span className="rig-card-name">{rig.name}</span>
                      {rig.beadsCount && rig.beadsCount > 0 && (
                        <span className="rig-card-beads">{rig.beadsCount}</span>
                      )}
                    </div>
                    {rig.tags?.template && (
                      <span className={`rig-card-template ${rig.tags.template}`}>
                        {rig.tags.template}
                      </span>
                    )}
                    {rig.tags?.tags && rig.tags.tags.length > 0 && (
                      <div className="rig-card-tags">
                        {rig.tags.tags.slice(0, 5).map(tag => (
                          <span key={tag} className="rig-tag">{tag}</span>
                        ))}
                        {rig.tags.tags.length > 5 && (
                          <span className="rig-tag-more">+{rig.tags.tags.length - 5}</span>
                        )}
                      </div>
                    )}
                    <div className="rig-card-path">{rig.path}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Skills Overview (aggregated from tags) */}
          {allTags.length > 0 && (
            <div className="wiki-skills-section">
              <h3>Skills & Technologien</h3>
              <div className="wiki-skills-cloud">
                {allTags.map(tag => {
                  const count = rigs.filter(r => r.tags?.tags?.includes(tag)).length;
                  return (
                    <button
                      key={tag}
                      className={`skill-tag ${filterTag === tag ? 'active' : ''}`}
                      onClick={() => setFilterTag(filterTag === tag ? '' : tag)}
                    >
                      {tag}
                      <span className="skill-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
