import { useState, useEffect } from 'react';

interface Project {
  id: string;
  path: string;
  name: string;
  type: 'tools' | 'projekt';
}

interface CoworkRepo {
  id: string;
  name: string;
  localPath: string;
  githubUrl: string;
  branch: string;
  hasCLAUDEmd: boolean;
}

interface WikiPage {
  name: string;
  path: string;
  mtime: number;
}

interface WikiPanelProps {
  projects: Project[];
  coworkRepos: CoworkRepo[];
}

// Unified entry for the combined list
interface WikiEntry {
  id: string;
  name: string;
  localPath: string;
  kind: 'tools' | 'projekt' | 'cowork';
  badge: string;
  subtitle?: string;
}

type NavSection = 'home' | 'projects' | 'logs';

function renderMarkdown(text: string): string {
  if (!text) return '';

  let html = text;

  // Code blocks first (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre class="wiki-code-block"><code${lang ? ` class="lang-${lang}"` : ''}>${escaped}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code class="wiki-inline-code">${escaped}</code>`;
  });

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Bold
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Tables (simple)
  html = html.replace(/((?:^\|.+\|\n)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n');
    let tableHtml = '<table class="wiki-table">';
    rows.forEach((row, idx) => {
      if (row.match(/^\|[\s-|]+\|$/)) return; // separator row
      const cells = row.split('|').slice(1, -1);
      const tag = idx === 0 ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
  });

  // Lists
  html = html.replace(/^(\s*)- (.+)$/gm, '<li>$2</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (match) => {
    if (match.startsWith('<ul>')) return match;
    return '<ul>' + match + '</ul>';
  });
  // Clean up nested ul
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Blockquote
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs (non-tag lines)
  const lines = html.split('\n');
  const processed: string[] = [];
  let inPre = false;

  for (const line of lines) {
    if (line.startsWith('<pre')) inPre = true;
    if (line.includes('</pre>')) { inPre = false; processed.push(line); continue; }
    if (inPre) { processed.push(line); continue; }

    if (line.trim() === '' || line.trim() === '<hr>') {
      processed.push(line);
    } else if (line.match(/^<(h[1-6]|ul|ol|li|table|tr|th|td|blockquote|pre|hr)/)) {
      processed.push(line);
    } else {
      processed.push(`<p>${line}</p>`);
    }
  }

  return processed.join('\n');
}

export default function WikiPanel({ projects, coworkRepos }: WikiPanelProps) {
  const [navSection, setNavSection] = useState<NavSection>('home');
  const [projectPages, setProjectPages] = useState<WikiPage[]>([]);
  const [logPages, setLogPages] = useState<WikiPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<{ path: string; title: string } | null>(null);
  const [pageContent, setPageContent] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  // Build unified entries list
  const allEntries: WikiEntry[] = [
    ...projects.map(p => ({
      id: p.id,
      name: p.name,
      localPath: p.path,
      kind: p.type as 'tools' | 'projekt',
      badge: p.type === 'tools' ? 'T' : 'P',
    })),
    ...coworkRepos.map(r => ({
      id: r.id,
      name: r.name,
      localPath: r.localPath,
      kind: 'cowork' as const,
      badge: 'C',
      subtitle: r.branch,
    })),
  ];

  useEffect(() => {
    loadPageList();
  }, []);

  async function loadPageList() {
    setLoadingList(true);
    const result = await window.electronAPI?.wikiListPages();
    setLoadingList(false);
    if (result?.success) {
      setProjectPages(result.projects || []);
      setLogPages(result.logs || []);
    }
  }

  async function loadPage(pagePath: string, title: string) {
    setSelectedPage({ path: pagePath, title });
    setLoadingPage(true);
    setPageContent(null);
    const result = await window.electronAPI?.wikiGetPage(pagePath);
    setLoadingPage(false);
    if (result?.success && result.content) {
      setPageContent(result.content);
    } else if (result?.success && result.content === null) {
      setPageContent('*(Keine Inhalte)*');
    }
  }

  async function handleSyncEntry(entry: WikiEntry) {
    setSyncing(entry.id);
    const result = await window.electronAPI?.wikiSyncProject(entry.localPath, entry.id);
    setSyncing(null);
    if (result?.success) {
      await loadPageList();
      await loadPage(`projects/${entry.id}.md`, entry.name);
    } else {
      alert(result?.error || 'Sync fehlgeschlagen');
    }
  }

  async function handleSyncAll() {
    for (const entry of allEntries) {
      setSyncing(entry.id);
      await window.electronAPI?.wikiSyncProject(entry.localPath, entry.id);
    }
    setSyncing(null);
    await loadPageList();
  }

  function formatDate(mtime: number): string {
    return new Date(mtime).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatLogName(name: string): string {
    const parts = name.split('-');
    if (parts.length > 3) {
      const datePart = parts.slice(0, 3).join('-');
      const titlePart = parts.slice(4).join(' ');
      return `${titlePart || name} (${datePart})`;
    }
    return name;
  }

  // Find the display name for a wiki page (match by id)
  function getPageDisplayName(page: WikiPage): string {
    const entry = allEntries.find(e => e.id === page.name);
    return entry ? entry.name : page.name.replace(/-/g, ' ');
  }

  const homeContent = `# Internes Wiki

Willkommen im Claude MC Wiki. Hier findest du:

- **Projekte**: Automatisch aus CLAUDE.md generierte Projektdokumentation
- **Coworking**: Synchronisierte Cowork-Repository-Dokumentation
- **Verlauf**: Gespeicherte Orchestrator-Chat-Sessions

## Projekte (${projects.length})

${projects.length > 0 ? projects.map(p => `- **${p.name}** (${p.type})`).join('\n') : '*(Keine Projekte)*'}

## Coworking (${coworkRepos.length})

${coworkRepos.length > 0 ? coworkRepos.map(r => `- **${r.name}** (${r.branch})`).join('\n') : '*(Keine Cowork-Repos)*'}
`;

  return (
    <div className="wiki-panel">
      {/* Left Navigation */}
      <div className="wiki-nav">
        <div className="wiki-nav-header">Wiki</div>

        <button
          className={`wiki-nav-item ${navSection === 'home' && !selectedPage ? 'active' : ''}`}
          onClick={() => { setNavSection('home'); setSelectedPage(null); }}
        >
          Startseite
        </button>

        <div className="wiki-nav-section-header">
          <span>Projekte & Cowork</span>
          <button className="orch-link" onClick={() => { setNavSection('projects'); setSelectedPage(null); }}>
            Alle
          </button>
        </div>

        {projectPages.map(page => (
          <button
            key={page.path}
            className={`wiki-nav-item wiki-nav-sub ${selectedPage?.path === page.path ? 'active' : ''}`}
            onClick={() => { setNavSection('projects'); loadPage(page.path, getPageDisplayName(page)); }}
          >
            {getPageDisplayName(page)}
          </button>
        ))}

        <div className="wiki-nav-section-header">
          <span>Verlauf</span>
          <button className="orch-link" onClick={() => { setNavSection('logs'); setSelectedPage(null); }}>
            Alle
          </button>
        </div>

        {logPages.slice(0, 10).map(page => (
          <button
            key={page.path}
            className={`wiki-nav-item wiki-nav-sub ${selectedPage?.path === page.path ? 'active' : ''}`}
            onClick={() => { setNavSection('logs'); loadPage(page.path, formatLogName(page.name)); }}
            title={page.name}
          >
            {formatLogName(page.name)}
          </button>
        ))}

        {loadingList && <div className="wiki-nav-loading">Lade...</div>}
      </div>

      {/* Right Content */}
      <div className="wiki-content">
        {/* Project + Cowork list view */}
        {navSection === 'projects' && !selectedPage && (
          <div className="wiki-content-inner">
            <div className="wiki-page-header">
              <h1>Projekte & Coworking</h1>
              <button className="btn-primary btn-small" onClick={handleSyncAll} disabled={!!syncing}>
                {syncing ? 'Sync läuft...' : 'Alle synchronisieren'}
              </button>
            </div>

            {/* Regular projects */}
            {projects.length > 0 && (
              <>
                <h2 className="wiki-section-label">Projekte</h2>
                <div className="wiki-project-list">
                  {projects.map(project => {
                    const entry = allEntries.find(e => e.id === project.id)!;
                    const existingPage = projectPages.find(p => p.name === project.id);
                    return (
                      <WikiEntryCard
                        key={project.id}
                        entry={entry}
                        existingPage={existingPage}
                        syncing={syncing}
                        onSync={() => handleSyncEntry(entry)}
                        onView={() => existingPage && loadPage(existingPage.path, project.name)}
                        formatDate={formatDate}
                      />
                    );
                  })}
                </div>
              </>
            )}

            {/* Cowork repos */}
            {coworkRepos.length > 0 && (
              <>
                <h2 className="wiki-section-label">Coworking</h2>
                <div className="wiki-project-list">
                  {coworkRepos.map(repo => {
                    const entry = allEntries.find(e => e.id === repo.id)!;
                    const existingPage = projectPages.find(p => p.name === repo.id);
                    return (
                      <WikiEntryCard
                        key={repo.id}
                        entry={entry}
                        existingPage={existingPage}
                        syncing={syncing}
                        onSync={() => handleSyncEntry(entry)}
                        onView={() => existingPage && loadPage(existingPage.path, repo.name)}
                        formatDate={formatDate}
                      />
                    );
                  })}
                </div>
              </>
            )}

            {allEntries.length === 0 && (
              <p className="wiki-empty">Keine Projekte oder Cowork-Repos vorhanden.</p>
            )}
          </div>
        )}

        {/* Log list view */}
        {navSection === 'logs' && !selectedPage && (
          <div className="wiki-content-inner">
            <h1>Verlauf</h1>
            {logPages.length === 0 ? (
              <p className="wiki-empty">Noch keine Chat-Logs gespeichert. Nutze den Orchestrator und speichere eine Session.</p>
            ) : (
              <div className="wiki-log-list">
                {logPages.map(page => (
                  <div key={page.path} className="wiki-log-item" onClick={() => loadPage(page.path, formatLogName(page.name))}>
                    <span className="wiki-log-title">{formatLogName(page.name)}</span>
                    <span className="wiki-log-date">{formatDate(page.mtime)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Home view */}
        {navSection === 'home' && !selectedPage && (
          <div className="wiki-content-inner">
            <div
              className="wiki-markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(homeContent) }}
            />
          </div>
        )}

        {/* Page view */}
        {selectedPage && (
          <div className="wiki-content-inner">
            {loadingPage ? (
              <div className="wiki-loading">Lade Seite...</div>
            ) : (
              <>
                <div className="wiki-page-header">
                  <h1>{selectedPage.title}</h1>
                  <button className="orch-btn-small" onClick={() => setSelectedPage(null)}>
                    ← Zurück
                  </button>
                </div>
                <div
                  className="wiki-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(pageContent || '') }}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Extracted card component to avoid duplication
function WikiEntryCard({ entry, existingPage, syncing, onSync, onView, formatDate }: {
  entry: WikiEntry;
  existingPage: WikiPage | undefined;
  syncing: string | null;
  onSync: () => void;
  onView: () => void;
  formatDate: (mtime: number) => string;
}) {
  return (
    <div className="wiki-project-card">
      <div className="wiki-project-card-info">
        <span className={`project-type-badge badge-${entry.kind}`}>
          {entry.badge}
        </span>
        <div>
          <span className="wiki-project-card-name">{entry.name}</span>
          {entry.subtitle && (
            <span className="wiki-project-card-sub">{entry.subtitle}</span>
          )}
        </div>
        {existingPage && (
          <span className="wiki-project-card-date">
            {formatDate(existingPage.mtime)}
          </span>
        )}
      </div>
      <div className="wiki-project-card-actions">
        {existingPage && (
          <button className="orch-btn-small" onClick={onView}>
            Anzeigen
          </button>
        )}
        <button
          className="orch-btn-small"
          onClick={onSync}
          disabled={syncing === entry.id}
        >
          {syncing === entry.id ? '...' : 'Sync'}
        </button>
      </div>
    </div>
  );
}
