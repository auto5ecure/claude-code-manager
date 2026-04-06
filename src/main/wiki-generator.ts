import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { WikiSettings, WikiUpdateResult } from '../shared/types';

const AUTO_START_MARKER = '<!-- AUTO-GENERATED-START -->';
const AUTO_END_MARKER = '<!-- AUTO-GENERATED-END -->';
const CHANGELOG_START_MARKER = '<!-- CHANGELOG-START -->';
const CHANGELOG_END_MARKER = '<!-- CHANGELOG-END -->';

interface ProjectInfo {
  name: string;
  path: string;
  type: 'tools' | 'projekt';
  gitBranch?: string;
  gitDirty?: boolean;
  claudeMdContent?: string;
}

interface ProjectStats {
  fileCount: number;
  folderCount: number;
  totalSize: string;
  languages: string[];
  lastCommitDate?: string;
  lastCommitMessage?: string;
  commitCount?: number;
  contributors?: string[];
}

interface CoworkInfo {
  name: string;
  path: string;
  githubUrl: string;
  remote: string;
  branch: string;
  lastSync?: string;
  claudeMdContent?: string;
}

interface SessionChanges {
  newFiles: string[];
  modifiedFiles: string[];
  gitCommits: string[];
  claudeMdUpdated: boolean;
}

/**
 * Detect the Obsidian vault path by searching for .obsidian folder
 */
export function detectVaultPath(projectPath: string): string | null {
  let current = projectPath;

  while (current !== path.dirname(current)) {
    const obsidianPath = path.join(current, '.obsidian');
    if (fs.existsSync(obsidianPath) && fs.statSync(obsidianPath).isDirectory()) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Get the relative path from vault to project
 */
export function getRelativeProjectPath(vaultPath: string, projectPath: string): string {
  return path.relative(vaultPath, projectPath);
}

/**
 * Get project statistics
 */
function getProjectStats(projectPath: string): ProjectStats {
  const stats: ProjectStats = {
    fileCount: 0,
    folderCount: 0,
    totalSize: '0 KB',
    languages: []
  };

  try {
    // Count files and folders (excluding node_modules, .git, etc.)
    const countFiles = (dir: string, depth = 0): { files: number; folders: number; size: number } => {
      if (depth > 5) return { files: 0, folders: 0, size: 0 }; // Limit depth

      let result = { files: 0, folders: 0, size: 0 };
      const items = fs.readdirSync(dir);

      for (const item of items) {
        if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'].includes(item)) continue;

        const fullPath = path.join(dir, item);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            result.folders++;
            const sub = countFiles(fullPath, depth + 1);
            result.files += sub.files;
            result.folders += sub.folders;
            result.size += sub.size;
          } else {
            result.files++;
            result.size += stat.size;
          }
        } catch {}
      }
      return result;
    };

    const counts = countFiles(projectPath);
    stats.fileCount = counts.files;
    stats.folderCount = counts.folders;

    // Format size
    if (counts.size < 1024) {
      stats.totalSize = `${counts.size} B`;
    } else if (counts.size < 1024 * 1024) {
      stats.totalSize = `${(counts.size / 1024).toFixed(1)} KB`;
    } else {
      stats.totalSize = `${(counts.size / (1024 * 1024)).toFixed(1)} MB`;
    }

    // Detect languages based on file extensions
    const langMap: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
      '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
      '.swift': 'Swift', '.c': 'C', '.cpp': 'C++', '.cs': 'C#', '.rb': 'Ruby',
      '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte', '.md': 'Markdown',
      '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
      '.sh': 'Shell', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML'
    };

    const detectLangs = (dir: string, depth = 0): Set<string> => {
      if (depth > 3) return new Set();
      const langs = new Set<string>();
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (['node_modules', '.git', 'dist', 'build'].includes(item)) continue;
          const fullPath = path.join(dir, item);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              detectLangs(fullPath, depth + 1).forEach(l => langs.add(l));
            } else {
              const ext = path.extname(item).toLowerCase();
              if (langMap[ext]) langs.add(langMap[ext]);
            }
          } catch {}
        }
      } catch {}
      return langs;
    };

    stats.languages = Array.from(detectLangs(projectPath)).slice(0, 5);

    // Git stats
    try {
      const lastCommit = execSync('git log -1 --format="%H|%s|%ai" 2>/dev/null', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      if (lastCommit) {
        const [, message, date] = lastCommit.split('|');
        stats.lastCommitMessage = message?.substring(0, 50);
        stats.lastCommitDate = date?.split(' ')[0];
      }

      const commitCount = execSync('git rev-list --count HEAD 2>/dev/null', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
      stats.commitCount = parseInt(commitCount) || 0;

      const contributors = execSync('git shortlog -sn --no-merges HEAD 2>/dev/null | head -5', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();
      stats.contributors = contributors.split('\n')
        .map(line => line.replace(/^\s*\d+\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
    } catch {}
  } catch {}

  return stats;
}

/**
 * Generate the project wiki content
 */
function generateProjectWikiContent(project: ProjectInfo, settings: WikiSettings): string {
  const now = new Date().toISOString().split('T')[0];
  const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);
  const stats = getProjectStats(project.path);
  const typeEmoji = project.type === 'tools' ? '🛠️' : '📁';
  const typeName = project.type === 'tools' ? 'Engineering Toolbox' : 'Staff Engineering';

  // Centered title
  let content = `<div align="center">\n\n`;
  content += `# ${typeEmoji} ${project.name}\n\n`;
  content += `**${typeName}**\n\n`;

  // Tags centered
  const tags: string[] = [`#projekt/${project.type}`];
  if (project.gitBranch) tags.push(`#git/${project.gitBranch}`);
  stats.languages.slice(0, 3).forEach(lang => tags.push(`#${lang.toLowerCase()}`));
  content += tags.join(' ') + '\n\n';
  content += `</div>\n\n`;

  content += `---\n\n`;

  // Auto-generated section
  content += `${AUTO_START_MARKER}\n`;

  // Quick Stats Cards
  content += `## 📊 Stats\n\n`;
  content += `| Dateien | Ordner | Größe | Commits | Branch |\n`;
  content += `|:-------:|:------:|:-----:|:-------:|:------:|\n`;
  const branchDisplay = project.gitBranch ? `\`${project.gitBranch}\`` : '-';
  content += `| ${stats.fileCount} | ${stats.folderCount} | ${stats.totalSize} | ${stats.commitCount || '-'} | ${branchDisplay} |\n\n`;

  // Languages
  if (stats.languages.length > 0) {
    content += `**Tech Stack:** `;
    content += stats.languages.map(lang => `\`${lang}\``).join(' · ');
    content += '\n\n';
  }

  // Git Info
  if (project.gitBranch) {
    const status = project.gitDirty ? '⚠️ Uncommitted' : '✅ Clean';
    content += `**Status:** ${status}`;
    if (stats.lastCommitMessage) {
      content += ` · _${stats.lastCommitMessage}_`;
    }
    content += '\n\n';

    if (stats.contributors && stats.contributors.length > 0) {
      content += `**Contributors:** ${stats.contributors.join(', ')}\n\n`;
    }
  }

  // Path as code block
  content += `**Pfad:**\n\`\`\`\n${project.path}\n\`\`\`\n`;

  content += `\n> _Aktualisiert: ${now} ${timeStr}_\n`;

  content += `\n${AUTO_END_MARKER}\n`;

  // CLAUDE.md content if available
  if (project.claudeMdContent) {
    content += `\n## 📖 Projektdokumentation\n\n`;
    content += `> [!note] Aus CLAUDE.md\n`;
    content += `> Diese Dokumentation wird automatisch aus der CLAUDE.md Datei übernommen.\n\n`;
    content += project.claudeMdContent;
    content += '\n';
  }

  // Changelog section
  if (settings.changelogEnabled) {
    content += `\n${CHANGELOG_START_MARKER}\n`;
    content += `## 📜 Changelog\n\n`;
    content += `${CHANGELOG_END_MARKER}\n`;
  }

  return content;
}

/**
 * Update only the auto-generated section of existing content
 */
function updateAutoGeneratedSection(existingContent: string, project: ProjectInfo): string {
  const now = new Date().toISOString().split('T')[0];
  const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);
  const stats = getProjectStats(project.path);

  // Generate new auto-generated content
  let newAutoSection = `${AUTO_START_MARKER}\n`;

  // Quick Stats Cards
  newAutoSection += `## 📊 Übersicht\n\n`;
  newAutoSection += `| 📄 Dateien | 📁 Ordner | 💾 Größe | 🔄 Commits |\n`;
  newAutoSection += `|:----------:|:---------:|:--------:|:----------:|\n`;
  newAutoSection += `| ${stats.fileCount} | ${stats.folderCount} | ${stats.totalSize} | ${stats.commitCount || '-'} |\n\n`;

  // Languages
  if (stats.languages.length > 0) {
    newAutoSection += `**Tech Stack:** `;
    newAutoSection += stats.languages.map(lang => `\`${lang}\``).join(' · ');
    newAutoSection += '\n\n';
  }

  // Git Info
  if (project.gitBranch) {
    newAutoSection += `## 🌿 Git\n\n`;
    newAutoSection += `| Branch | Status | Letzter Commit |\n`;
    newAutoSection += `|--------|--------|----------------|\n`;
    const status = project.gitDirty ? '⚠️ Uncommitted' : '✅ Clean';
    const lastCommit = stats.lastCommitMessage ? `${stats.lastCommitDate}: ${stats.lastCommitMessage}` : '-';
    newAutoSection += `| \`${project.gitBranch}\` | ${status} | ${lastCommit} |\n\n`;

    if (stats.contributors && stats.contributors.length > 0) {
      newAutoSection += `**Contributors:** ${stats.contributors.join(', ')}\n\n`;
    }
  }

  // Quick Actions
  newAutoSection += `## ⚡ Quick Actions\n\n`;
  newAutoSection += `| Aktion | Beschreibung |\n`;
  newAutoSection += `|--------|-------------|\n`;
  newAutoSection += `| 📂 Finder | \`open "${project.path}"\` |\n`;
  newAutoSection += `| 💻 Terminal | \`cd "${project.path}"\` |\n`;
  newAutoSection += `| 📝 CLAUDE.md | \`code "${project.path}/CLAUDE.md"\` |\n\n`;

  // Project Path
  newAutoSection += `## 📍 Pfad\n\n`;
  newAutoSection += `\`\`\`\n${project.path}\n\`\`\`\n`;
  newAutoSection += `\n> Aktualisiert: ${now} ${timeStr}\n`;

  newAutoSection += `\n${AUTO_END_MARKER}`;

  // Check if markers exist
  if (existingContent.includes(AUTO_START_MARKER) && existingContent.includes(AUTO_END_MARKER)) {
    // Replace existing auto-generated section
    const regex = new RegExp(`${escapeRegExp(AUTO_START_MARKER)}[\\s\\S]*?${escapeRegExp(AUTO_END_MARKER)}`, 'g');
    return existingContent.replace(regex, newAutoSection);
  } else {
    // Insert after title (first line)
    const lines = existingContent.split('\n');
    const titleIndex = lines.findIndex(l => l.startsWith('# '));
    if (titleIndex >= 0) {
      lines.splice(titleIndex + 1, 0, '', newAutoSection);
      return lines.join('\n');
    }
    return newAutoSection + '\n\n' + existingContent;
  }
}

/**
 * Append a changelog entry to existing content
 */
function appendChangelogEntry(existingContent: string, entry: string): string {
  if (existingContent.includes(CHANGELOG_START_MARKER) && existingContent.includes(CHANGELOG_END_MARKER)) {
    // Insert entry after CHANGELOG-START marker
    const startIndex = existingContent.indexOf(CHANGELOG_START_MARKER) + CHANGELOG_START_MARKER.length;

    // Find where to insert (after "## Changelog" if present)
    const afterStart = existingContent.substring(startIndex);
    const changelogIndex = afterStart.indexOf('## Changelog');

    if (changelogIndex >= 0) {
      const insertPoint = startIndex + changelogIndex + '## Changelog'.length;
      return existingContent.substring(0, insertPoint) + '\n\n' + entry + existingContent.substring(insertPoint);
    } else {
      return existingContent.substring(0, startIndex) + '\n## Changelog\n\n' + entry + afterStart;
    }
  } else {
    // Append at end
    return existingContent + `\n\n${CHANGELOG_START_MARKER}\n## Changelog\n\n${entry}\n${CHANGELOG_END_MARKER}\n`;
  }
}

/**
 * Generate a changelog entry for a session
 */
function generateChangelogEntry(changes: SessionChanges): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

  let entry = `### ${dateStr} ${timeStr}\n\n`;

  if (changes.newFiles.length > 0) {
    entry += `**Neue Dateien**\n`;
    changes.newFiles.slice(0, 10).forEach(f => {
      entry += `- \`${f}\`\n`;
    });
    if (changes.newFiles.length > 10) {
      entry += `- ... und ${changes.newFiles.length - 10} weitere\n`;
    }
    entry += '\n';
  }

  if (changes.modifiedFiles.length > 0) {
    entry += `**Geänderte Dateien**\n`;
    changes.modifiedFiles.slice(0, 10).forEach(f => {
      entry += `- \`${f}\`\n`;
    });
    if (changes.modifiedFiles.length > 10) {
      entry += `- ... und ${changes.modifiedFiles.length - 10} weitere\n`;
    }
    entry += '\n';
  }

  if (changes.gitCommits.length > 0) {
    entry += `**Git Commits**\n`;
    changes.gitCommits.slice(0, 5).forEach(c => {
      entry += `- ${c}\n`;
    });
    if (changes.gitCommits.length > 5) {
      entry += `- ... und ${changes.gitCommits.length - 5} weitere\n`;
    }
    entry += '\n';
  }

  if (changes.claudeMdUpdated) {
    entry += `> CLAUDE.md wurde aktualisiert\n\n`;
  }

  entry += '---\n';

  return entry;
}

/**
 * Get git changes since last wiki update
 */
export function getGitChanges(projectPath: string, sinceDate?: string): SessionChanges {
  const changes: SessionChanges = {
    newFiles: [],
    modifiedFiles: [],
    gitCommits: [],
    claudeMdUpdated: false
  };

  try {
    // Get uncommitted changes
    const statusOutput = execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8'
    });

    statusOutput.split('\n').filter(Boolean).forEach(line => {
      const status = line.substring(0, 2);
      const file = line.substring(3).trim();

      if (status.includes('A') || status === '??') {
        changes.newFiles.push(file);
      } else if (status.includes('M')) {
        changes.modifiedFiles.push(file);
      }

      if (file === 'CLAUDE.md' || file.endsWith('/CLAUDE.md')) {
        changes.claudeMdUpdated = true;
      }
    });

    // Get recent commits (last 24h or since date)
    const sinceArg = sinceDate ? `--since="${sinceDate}"` : '--since="24 hours ago"';
    const logOutput = execSync(`git log ${sinceArg} --oneline 2>/dev/null || true`, {
      cwd: projectPath,
      encoding: 'utf-8'
    });

    changes.gitCommits = logOutput.split('\n').filter(Boolean).map(line => {
      // Format: hash message
      const spaceIndex = line.indexOf(' ');
      return spaceIndex > 0 ? line.substring(spaceIndex + 1) : line;
    });

  } catch {
    // Not a git repo or git not available
  }

  return changes;
}

/**
 * Generate or update the project-level wiki
 */
export async function generateProjectWiki(
  project: ProjectInfo,
  settings: WikiSettings,
  changes?: SessionChanges
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    let wikiPath: string;
    let wikiContent: string;

    if (settings.projectWikiFormat === 'folder') {
      // Folder format: project/Wiki/README.md
      const wikiDir = path.join(project.path, 'Wiki');
      wikiPath = path.join(wikiDir, 'README.md');

      if (!fs.existsSync(wikiDir)) {
        fs.mkdirSync(wikiDir, { recursive: true });
      }
    } else {
      // File format: project/WIKI.md
      wikiPath = path.join(project.path, 'WIKI.md');
    }

    // Check if file exists
    if (fs.existsSync(wikiPath)) {
      // Update existing file
      const existingContent = fs.readFileSync(wikiPath, 'utf-8');
      wikiContent = updateAutoGeneratedSection(existingContent, project);

      // Append changelog if enabled and changes provided
      if (settings.changelogEnabled && changes && hasChanges(changes)) {
        const entry = generateChangelogEntry(changes);
        wikiContent = appendChangelogEntry(wikiContent, entry);
      }
    } else {
      // Create new file
      wikiContent = generateProjectWikiContent(project, settings);

      // Add initial changelog entry if enabled
      if (settings.changelogEnabled && changes && hasChanges(changes)) {
        const entry = generateChangelogEntry(changes);
        wikiContent = appendChangelogEntry(wikiContent, entry);
      }
    }

    fs.writeFileSync(wikiPath, wikiContent, 'utf-8');

    return { success: true, path: wikiPath };
  } catch (err) {
    return { success: false, path: '', error: String(err) };
  }
}

/**
 * Generate or update the vault-level wiki page for a project
 */
export async function updateVaultWiki(
  project: ProjectInfo,
  vaultPath: string
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    // Create project page (filename from project name, sanitized)
    const safeProjectName = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const projectWikiPath = path.join(wikiDir, `${safeProjectName}.md`);

    const now = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);
    const stats = getProjectStats(project.path);
    const typeEmoji = project.type === 'tools' ? '🛠️' : '📁';
    const typeName = project.type === 'tools' ? 'Engineering Toolbox' : 'Staff Engineering';

    // Centered title
    let content = `<div align="center">\n\n`;
    content += `# ${typeEmoji} ${project.name}\n\n`;
    content += `**${typeName}**\n\n`;

    // Tags centered
    const tags: string[] = [`#projekt/${project.type}`];
    if (project.gitBranch) tags.push(`#git/${project.gitBranch}`);
    stats.languages.slice(0, 3).forEach(lang => tags.push(`#${lang.toLowerCase()}`));
    content += tags.join(' ') + '\n\n';
    content += `</div>\n\n`;

    content += `---\n\n`;

    content += `${AUTO_START_MARKER}\n`;

    // Stats - consistent format
    content += `## 📊 Stats\n\n`;
    content += `| Dateien | Ordner | Größe | Commits | Branch |\n`;
    content += `|:-------:|:------:|:-----:|:-------:|:------:|\n`;
    const branchDisplay = project.gitBranch ? `\`${project.gitBranch}\`` : '-';
    content += `| ${stats.fileCount} | ${stats.folderCount} | ${stats.totalSize} | ${stats.commitCount || '-'} | ${branchDisplay} |\n\n`;

    if (stats.languages.length > 0) {
      content += `**Stack:** ${stats.languages.map(l => `\`${l}\``).join(' · ')}\n\n`;
    }

    // Git
    if (project.gitBranch) {
      const status = project.gitDirty ? '⚠️' : '✅';
      content += `**Git:** \`${project.gitBranch}\` ${status}`;
      if (stats.lastCommitMessage) {
        content += ` • _${stats.lastCommitMessage}_`;
      }
      content += '\n\n';
    }

    content += `> Aktualisiert: ${now} ${timeStr}\n`;
    content += `\n${AUTO_END_MARKER}\n`;

    // Add CLAUDE.md summary if available
    if (project.claudeMdContent) {
      content += `\n## 📖 Dokumentation\n\n`;
      content += `> [!note] CLAUDE.md\n\n`;
      // Extract first section or first 500 chars
      const summary = project.claudeMdContent.split('\n').slice(0, 20).join('\n');
      content += summary;
      if (project.claudeMdContent.length > summary.length) {
        content += '\n\n---\n*→ Vollständige Dokumentation im Projekt*\n';
      }
    }

    // If file exists, preserve manual sections
    if (fs.existsSync(projectWikiPath)) {
      const existing = fs.readFileSync(projectWikiPath, 'utf-8');
      content = updateAutoGeneratedSection(existing, project);
    }

    fs.writeFileSync(projectWikiPath, content, 'utf-8');

    // Update the index
    await updateVaultIndex(vaultPath);

    return { success: true, path: projectWikiPath };
  } catch (err) {
    return { success: false, path: '', error: String(err) };
  }
}

/**
 * Regenerate the vault-level project index
 */
export async function updateVaultIndex(vaultPath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    const indexPath = path.join(wikiDir, '_index.md');

    // Get all project wiki files
    const files = fs.readdirSync(wikiDir).filter(f => f.endsWith('.md') && f !== '_index.md');

    const now = new Date().toISOString().split('T')[0];

    let content = `# Projekt-Index\n\n`;
    content += `> Automatisch generiert am ${now}\n\n`;
    content += `## Projekte\n\n`;

    for (const file of files.sort()) {
      const projectName = file.replace('.md', '');
      // Use Obsidian wikilink format
      content += `- [[${projectName}]]\n`;
    }

    if (files.length === 0) {
      content += `*Keine Projekte mit Wiki-Integration gefunden.*\n`;
    }

    fs.writeFileSync(indexPath, content, 'utf-8');

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Regenerate the vault index with all provided projects
 */
export async function regenerateFullVaultIndex(
  vaultPath: string,
  projects: ProjectInfo[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    const indexPath = path.join(wikiDir, '_index.md');
    const now = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);

    // Group projects by type
    const toolsProjects = projects.filter(p => p.type === 'tools');
    const staffProjects = projects.filter(p => p.type === 'projekt');

    let content = `# 🗂️ Projekt-Übersicht\n\n`;
    content += `> Automatisch aktualisiert: ${now} ${timeStr}\n\n`;
    content += `---\n\n`;

    // Summary stats
    content += `## 📊 Übersicht\n\n`;
    content += `| Typ | Anzahl |\n`;
    content += `|-----|--------|\n`;
    content += `| Engineering Toolbox | ${toolsProjects.length} |\n`;
    content += `| Staff Engineering | ${staffProjects.length} |\n`;
    content += `| **Gesamt** | **${projects.length}** |\n\n`;

    // Tools projects
    if (toolsProjects.length > 0) {
      content += `## 🛠️ Engineering Toolbox\n\n`;
      content += `| Projekt | Branch | Status |\n`;
      content += `|---------|--------|--------|\n`;
      for (const p of toolsProjects.sort((a, b) => a.name.localeCompare(b.name))) {
        const safeName = p.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const wikiLink = fs.existsSync(path.join(wikiDir, `${safeName}.md`)) ? `[[${safeName}\\|${p.name}]]` : p.name;
        const branch = p.gitBranch || '-';
        const status = p.gitDirty ? '⚠️ Uncommitted' : '✅';
        content += `| ${wikiLink} | \`${branch}\` | ${status} |\n`;
      }
      content += '\n';
    }

    // Staff projects
    if (staffProjects.length > 0) {
      content += `## 📁 Staff Engineering\n\n`;
      content += `| Projekt | Branch | Status |\n`;
      content += `|---------|--------|--------|\n`;
      for (const p of staffProjects.sort((a, b) => a.name.localeCompare(b.name))) {
        const safeName = p.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const wikiLink = fs.existsSync(path.join(wikiDir, `${safeName}.md`)) ? `[[${safeName}\\|${p.name}]]` : p.name;
        const branch = p.gitBranch || '-';
        const status = p.gitDirty ? '⚠️ Uncommitted' : '✅';
        content += `| ${wikiLink} | \`${branch}\` | ${status} |\n`;
      }
      content += '\n';
    }

    if (projects.length === 0) {
      content += `*Keine Projekte registriert.*\n`;
    }

    fs.writeFileSync(indexPath, content, 'utf-8');

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Full wiki update for a project (both project-level and vault-level)
 */
export async function updateProjectWiki(
  project: ProjectInfo,
  settings: WikiSettings,
  changes?: SessionChanges
): Promise<WikiUpdateResult> {
  const result: WikiUpdateResult = { success: false };

  if (!settings.enabled) {
    return { success: true };
  }

  try {
    // Get changes if not provided and tracking is enabled
    if (!changes && settings.fileTrackingEnabled) {
      changes = getGitChanges(project.path, settings.lastUpdated);
    }

    // Update project-level wiki
    const projectResult = await generateProjectWiki(project, settings, changes);
    if (projectResult.success) {
      result.projectWikiPath = projectResult.path;
    } else {
      result.error = projectResult.error;
      return result;
    }

    // Update vault-level wiki if vault path is set and createVaultPage is enabled
    if (settings.vaultPath && settings.createVaultPage !== false) {
      const vaultResult = await updateVaultWiki(project, settings.vaultPath);
      if (vaultResult.success) {
        result.vaultWikiPath = vaultResult.path;
      } else {
        result.error = vaultResult.error;
        return result;
      }
    }

    result.success = true;
    return result;
  } catch (err) {
    result.error = String(err);
    return result;
  }
}

/**
 * Generate or update the vault-level wiki page for a cowork repository
 */
export async function updateCoworkVaultWiki(
  cowork: CoworkInfo,
  vaultPath: string
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    // Create project page (filename from project name, sanitized)
    const safeProjectName = cowork.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const projectWikiPath = path.join(wikiDir, `${safeProjectName}.md`);

    const now = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);
    const stats = getProjectStats(cowork.path);

    // Extract repo info from GitHub URL
    const repoPath = cowork.githubUrl.replace('https://github.com/', '');
    const owner = repoPath.split('/')[0];

    // Centered title
    let content = `<div align="center">\n\n`;
    content += `# 🤝 ${cowork.name}\n\n`;
    content += `**Coworking Repository**\n\n`;

    // Tags centered
    content += `#cowork #github/${owner} #git/${cowork.branch}`;
    stats.languages.slice(0, 3).forEach(lang => {
      content += ` #${lang.toLowerCase()}`;
    });
    content += '\n\n';

    // GitHub link centered
    content += `[📂 ${repoPath}](${cowork.githubUrl})\n\n`;
    content += `</div>\n\n`;

    content += `---\n\n`;

    content += `${AUTO_START_MARKER}\n`;

    // Stats - consistent format
    content += `## 📊 Stats\n\n`;
    content += `| Dateien | Ordner | Größe | Commits | Branch |\n`;
    content += `|:-------:|:------:|:-----:|:-------:|:------:|\n`;
    content += `| ${stats.fileCount} | ${stats.folderCount} | ${stats.totalSize} | ${stats.commitCount || '-'} | \`${cowork.branch}\` |\n\n`;

    if (stats.languages.length > 0) {
      content += `**Tech Stack:** ${stats.languages.map(l => `\`${l}\``).join(' · ')}\n\n`;
    }

    // Git Info
    const lastSync = cowork.lastSync ? new Date(cowork.lastSync).toLocaleString('de-DE') : '-';
    content += `**Remote:** \`${cowork.remote}\` · **Letzter Sync:** ${lastSync}\n\n`;

    if (stats.lastCommitMessage) {
      content += `**Letzter Commit:** _${stats.lastCommitMessage}_\n\n`;
    }

    if (stats.contributors && stats.contributors.length > 0) {
      content += `**Contributors:** ${stats.contributors.join(', ')}\n\n`;
    }

    // Quick Links as grid
    content += `## 🔗 Links\n\n`;
    content += `| | | |\n`;
    content += `|:---:|:---:|:---:|\n`;
    content += `| [Code](${cowork.githubUrl}) | [Issues](${cowork.githubUrl}/issues) | [PRs](${cowork.githubUrl}/pulls) |\n`;
    content += `| [Commits](${cowork.githubUrl}/commits/${cowork.branch}) | [Actions](${cowork.githubUrl}/actions) | [Wiki](${cowork.githubUrl}/wiki) |\n\n`;

    // Local path
    content += `**Pfad:**\n\`\`\`\n${cowork.path}\n\`\`\`\n`;

    content += `\n> _Aktualisiert: ${now} ${timeStr}_\n`;
    content += `\n${AUTO_END_MARKER}\n`;

    // Add CLAUDE.md summary if available
    if (cowork.claudeMdContent) {
      content += `\n## 📖 Dokumentation\n\n`;
      content += `> [!note] CLAUDE.md\n\n`;
      const summary = cowork.claudeMdContent.split('\n').slice(0, 20).join('\n');
      content += summary;
      if (cowork.claudeMdContent.length > summary.length) {
        content += '\n\n---\n*→ Vollständige Dokumentation im Projekt*\n';
      }
    }

    // If file exists, preserve manual sections
    if (fs.existsSync(projectWikiPath)) {
      const existing = fs.readFileSync(projectWikiPath, 'utf-8');
      content = updateCoworkAutoSection(existing, cowork, vaultPath);
    }

    fs.writeFileSync(projectWikiPath, content, 'utf-8');

    return { success: true, path: projectWikiPath };
  } catch (err) {
    return { success: false, path: '', error: String(err) };
  }
}

/**
 * Update the auto-generated section for cowork repos
 */
function updateCoworkAutoSection(existingContent: string, cowork: CoworkInfo, _vaultPath: string): string {
  const now = new Date().toISOString().split('T')[0];
  const timeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);
  const stats = getProjectStats(cowork.path);

  let newAutoSection = `${AUTO_START_MARKER}\n`;

  // Stats
  newAutoSection += `## 📊 Stats\n\n`;
  newAutoSection += `| 📄 Files | 📁 Folders | 💾 Size | 🔄 Commits |\n`;
  newAutoSection += `|:--------:|:----------:|:-------:|:----------:|\n`;
  newAutoSection += `| ${stats.fileCount} | ${stats.folderCount} | ${stats.totalSize} | ${stats.commitCount || '-'} |\n\n`;

  if (stats.languages.length > 0) {
    newAutoSection += `**Tech Stack:** ${stats.languages.map(l => `\`${l}\``).join(' · ')}\n\n`;
  }

  // Git Info
  newAutoSection += `## 🌿 Repository\n\n`;
  newAutoSection += `| Remote | Branch | Letzter Sync |\n`;
  newAutoSection += `|--------|--------|-------------|\n`;
  const lastSync = cowork.lastSync ? new Date(cowork.lastSync).toLocaleString('de-DE') : '-';
  newAutoSection += `| \`${cowork.remote}\` | \`${cowork.branch}\` | ${lastSync} |\n\n`;

  if (stats.lastCommitMessage) {
    newAutoSection += `**Letzter Commit:** _${stats.lastCommitMessage}_ (${stats.lastCommitDate})\n\n`;
  }

  if (stats.contributors && stats.contributors.length > 0) {
    newAutoSection += `**Contributors:** ${stats.contributors.join(', ')}\n\n`;
  }

  // Quick Links as cards
  newAutoSection += `## ⚡ Quick Links\n\n`;
  newAutoSection += `| | | |\n`;
  newAutoSection += `|:---:|:---:|:---:|\n`;
  newAutoSection += `| [📂 Code](${cowork.githubUrl}) | [🌿 Branch](${cowork.githubUrl}/tree/${cowork.branch}) | [📋 Issues](${cowork.githubUrl}/issues) |\n`;
  newAutoSection += `| [🔀 PRs](${cowork.githubUrl}/pulls) | [📜 Commits](${cowork.githubUrl}/commits/${cowork.branch}) | [⚙️ Actions](${cowork.githubUrl}/actions) |\n\n`;

  // Local path
  newAutoSection += `## 📍 Lokal\n\n`;
  newAutoSection += `\`\`\`\n${cowork.path}\n\`\`\`\n\n`;

  newAutoSection += `> Aktualisiert: ${now} ${timeStr}\n`;
  newAutoSection += `\n${AUTO_END_MARKER}`;

  // Check if markers exist
  if (existingContent.includes(AUTO_START_MARKER) && existingContent.includes(AUTO_END_MARKER)) {
    const regex = new RegExp(`${escapeRegExp(AUTO_START_MARKER)}[\\s\\S]*?${escapeRegExp(AUTO_END_MARKER)}`, 'g');
    return existingContent.replace(regex, newAutoSection);
  } else {
    const lines = existingContent.split('\n');
    const titleIndex = lines.findIndex(l => l.startsWith('# '));
    if (titleIndex >= 0) {
      lines.splice(titleIndex + 1, 0, '', newAutoSection);
      return lines.join('\n');
    }
    return newAutoSection + '\n\n' + existingContent;
  }
}

/**
 * Regenerate the vault index including both projects and cowork repos
 */
export async function regenerateFullVaultIndexWithCowork(
  vaultPath: string,
  projects: ProjectInfo[],
  coworkRepos: CoworkInfo[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    const indexPath = path.join(wikiDir, '_index.md');
    const now = new Date().toISOString().split('T')[0];

    // Filter to only include projects within this vault
    // Note: coworkRepos are already pre-filtered by wikiVaultPath by the caller
    const vaultProjects = projects.filter(p => p.path.startsWith(vaultPath));
    const vaultCoworkRepos = coworkRepos; // Already filtered by wikiVaultPath
    console.log(`[regenerateFullVaultIndexWithCowork] vaultPath: ${vaultPath}`);
    console.log(`[regenerateFullVaultIndexWithCowork] projects: ${projects.length}, vaultProjects: ${vaultProjects.length}`);
    console.log(`[regenerateFullVaultIndexWithCowork] coworkRepos: ${coworkRepos.length}`);
    vaultCoworkRepos.forEach(r => console.log(`  - cowork: ${r.name}`));

    // Group projects by type
    const toolsProjects = vaultProjects.filter(p => p.type === 'tools');
    const staffProjects = vaultProjects.filter(p => p.type === 'projekt');

    // Check if existing file has content outside markers to preserve
    let existingContent = '';
    let beforeMarker = '';
    let afterMarker = '';

    if (fs.existsSync(indexPath)) {
      existingContent = fs.readFileSync(indexPath, 'utf-8');

      const startIdx = existingContent.indexOf(AUTO_START_MARKER);
      const endIdx = existingContent.indexOf(AUTO_END_MARKER);

      if (startIdx !== -1 && endIdx !== -1) {
        beforeMarker = existingContent.substring(0, startIdx);
        afterMarker = existingContent.substring(endIdx + AUTO_END_MARKER.length);
      }
    }

    // Get vault name from path
    const vaultName = path.basename(vaultPath).replace('_vault', '');

    // Build content - use existing header or default centered header
    let content = beforeMarker || `<div align="center">\n\n# 🗂️ Projekt-Übersicht\n\n**${vaultName}**\n\n</div>\n\n---\n\n`;

    content += `${AUTO_START_MARKER}\n\n`;

    // Single table with all projects
    content += `| Projekt | Beschreibung | Typ | Branch | Status |\n`;
    content += `|---------|--------------|:---:|:------:|:------:|\n`;

    // All projects sorted by type then name
    const allItems: Array<{name: string; safeName: string; description: string; type: string; typeEmoji: string; branch: string; status: string; githubUrl?: string}> = [];

    // Add tools projects
    for (const p of toolsProjects) {
      const safeName = p.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const desc = extractDescription(p.claudeMdContent);
      allItems.push({
        name: p.name,
        safeName,
        description: desc,
        type: 'tools',
        typeEmoji: '🛠️',
        branch: p.gitBranch || '-',
        status: p.gitDirty ? '⚠️' : '✅'
      });
    }

    // Add staff projects
    for (const p of staffProjects) {
      const safeName = p.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const desc = extractDescription(p.claudeMdContent);
      allItems.push({
        name: p.name,
        safeName,
        description: desc,
        type: 'projekt',
        typeEmoji: '📁',
        branch: p.gitBranch || '-',
        status: p.gitDirty ? '⚠️' : '✅'
      });
    }

    // Add cowork repos
    for (const r of vaultCoworkRepos) {
      const safeName = r.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const desc = extractDescription(r.claudeMdContent);
      const repoPath = r.githubUrl.replace('https://github.com/', '');
      allItems.push({
        name: r.name,
        safeName,
        description: desc ? `${desc} · [GitHub](${r.githubUrl})` : `[${repoPath}](${r.githubUrl})`,
        type: 'cowork',
        typeEmoji: '🤝',
        branch: r.branch,
        status: '✅',
        githubUrl: r.githubUrl
      });
    }

    // Sort by type (tools, projekt, cowork) then by name
    const typeOrder: Record<string, number> = { tools: 0, projekt: 1, cowork: 2 };
    allItems.sort((a, b) => {
      const typeCompare = typeOrder[a.type] - typeOrder[b.type];
      if (typeCompare !== 0) return typeCompare;
      return a.name.localeCompare(b.name);
    });

    // Generate table rows
    for (const item of allItems) {
      const wikiLink = fs.existsSync(path.join(wikiDir, `${item.safeName}.md`))
        ? `[[${item.safeName}\\|${item.name}]]`
        : item.name;
      const branchDisplay = item.branch !== '-' ? `\`${item.branch}\`` : '-';
      content += `| ${wikiLink} | ${item.description} | ${item.typeEmoji} | ${branchDisplay} | ${item.status} |\n`;
    }

    if (allItems.length === 0) {
      content += `| - | *Keine Projekte registriert* | - | - | - |\n`;
    }

    content += `\n---\n\n_Aktualisiert: ${now}_\n\n`;
    content += `${AUTO_END_MARKER}\n`;

    // Append preserved content after marker, or add placeholder for custom content
    if (afterMarker.trim()) {
      content += afterMarker;
    } else {
      content += `\n## 📝 Notizen\n\n*Eigene Notizen hier hinzufügen...*\n`;
    }

    fs.writeFileSync(indexPath, content, 'utf-8');

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Update only the cowork project's entry in the vault index
 * Does not touch other entries or regenerate the entire index
 */
export async function updateCoworkVaultIndexEntry(
  cowork: CoworkInfo,
  vaultPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const wikiDir = path.join(vaultPath, 'Wiki', 'Projekte');
    const indexPath = path.join(wikiDir, '_index.md');

    // Ensure directory exists
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(wikiDir, { recursive: true });
    }

    const safeName = cowork.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const desc = extractDescription(cowork.claudeMdContent);
    const repoPath = cowork.githubUrl.replace('https://github.com/', '').replace('.git', '');
    const description = desc !== '-' ? `${desc} · [GitHub](${cowork.githubUrl})` : `[${repoPath}](${cowork.githubUrl})`;
    const wikiLink = fs.existsSync(path.join(wikiDir, `${safeName}.md`))
      ? `[[${safeName}\\|${cowork.name}]]`
      : cowork.name;
    const branchDisplay = `\`${cowork.branch}\``;
    const newRow = `| ${wikiLink} | ${description} | 🤝 | ${branchDisplay} | ✅ |`;

    if (!fs.existsSync(indexPath)) {
      // Create a minimal index with just the cowork entry
      const now = new Date().toISOString().split('T')[0];
      const vaultName = path.basename(vaultPath).replace('_vault', '');
      let content = `<div align="center">\n\n# 🗂️ Projekt-Übersicht\n\n**${vaultName}**\n\n</div>\n\n---\n\n`;
      content += `${AUTO_START_MARKER}\n\n`;
      content += `| Projekt | Beschreibung | Typ | Branch | Status |\n`;
      content += `|---------|--------------|:---:|:------:|:------:|\n`;
      content += `${newRow}\n`;
      content += `\n---\n\n_Aktualisiert: ${now}_\n\n`;
      content += `${AUTO_END_MARKER}\n`;
      content += `\n## 📝 Notizen\n\n*Eigene Notizen hier hinzufügen...*\n`;
      fs.writeFileSync(indexPath, content, 'utf-8');
      return { success: true };
    }

    // Read existing content
    let content = fs.readFileSync(indexPath, 'utf-8');

    // Find the table in the auto-generated section
    const startIdx = content.indexOf(AUTO_START_MARKER);
    const endIdx = content.indexOf(AUTO_END_MARKER);

    if (startIdx === -1 || endIdx === -1) {
      // No auto-generated section, append at the end before the marker or at end
      return { success: false, error: 'Kein AUTO-GENERATED Bereich gefunden. Bitte Index manuell regenerieren.' };
    }

    const beforeAuto = content.substring(0, startIdx);
    const autoSection = content.substring(startIdx, endIdx + AUTO_END_MARKER.length);
    const afterAuto = content.substring(endIdx + AUTO_END_MARKER.length);

    // Check if this cowork project already has an entry (by wiki link or name)
    const rowPatterns = [
      new RegExp(`^\\|.*\\[\\[${escapeRegExp(safeName)}.*$`, 'gm'),
      new RegExp(`^\\|.*${escapeRegExp(cowork.name)}.*🤝.*$`, 'gm')
    ];

    let newAutoSection = autoSection;
    let entryFound = false;

    for (const pattern of rowPatterns) {
      if (pattern.test(newAutoSection)) {
        // Replace existing row
        newAutoSection = newAutoSection.replace(pattern, newRow);
        entryFound = true;
        break;
      }
    }

    if (!entryFound) {
      // Add new row at the end of the table (before the empty line after the table)
      // Find the last table row and add after it
      const tableEndMatch = newAutoSection.match(/(\|[^\n]+\|\n)(\n---)/);
      if (tableEndMatch) {
        newAutoSection = newAutoSection.replace(
          tableEndMatch[0],
          `${tableEndMatch[1]}${newRow}\n${tableEndMatch[2]}`
        );
      } else {
        // Fallback: just add before the closing marker
        newAutoSection = newAutoSection.replace(
          AUTO_END_MARKER,
          `${newRow}\n\n${AUTO_END_MARKER}`
        );
      }
    }

    // Update the timestamp in the auto section
    const now = new Date().toISOString().split('T')[0];
    newAutoSection = newAutoSection.replace(/_Aktualisiert: \d{4}-\d{2}-\d{2}_/, `_Aktualisiert: ${now}_`);

    content = beforeAuto + newAutoSection + afterAuto;
    fs.writeFileSync(indexPath, content, 'utf-8');

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Helper functions
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasChanges(changes: SessionChanges): boolean {
  return changes.newFiles.length > 0 ||
         changes.modifiedFiles.length > 0 ||
         changes.gitCommits.length > 0 ||
         changes.claudeMdUpdated;
}

/**
 * Extract a short description from CLAUDE.md content
 */
function extractDescription(claudeMdContent?: string): string {
  if (!claudeMdContent) return '-';

  // Try to find a description line or first meaningful content
  const lines = claudeMdContent.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers, code blocks, empty lines
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('|')) continue;

    // Found a description line - clean it up
    let desc = trimmed
      .replace(/\*\*/g, '')  // Remove bold
      .replace(/\*/g, '')    // Remove italic
      .replace(/`/g, '')     // Remove code
      .substring(0, 50);     // Limit length

    if (desc.length >= 50) desc = desc.substring(0, 47) + '...';
    if (desc.length > 5) return desc;
  }

  return '-';
}
