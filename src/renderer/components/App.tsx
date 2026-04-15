import { useState, useEffect } from 'react';
import NavSidebar, { type NavView } from './NavSidebar';
import HomeView from './HomeView';
import ProjectsPanel from './ProjectsPanel';
import CoworkPanel from './CoworkPanel';
import StatusBar from './StatusBar';
import Terminal, { Tab } from './Terminal';
import ScreenshotPreview from './ScreenshotPreview';
import EditorPanel from './EditorPanel';
import QuickCommands from './QuickCommands';
import LogViewer from './LogViewer';
import TypeSelector from './TypeSelector';
import ProgressModal from './ProgressModal';
import ProjectInfoModal from './ProjectInfoModal';
import AddCoworkRepoModal from './AddCoworkRepoModal';
import PreFlightModal from './PreFlightModal';
import CommitModal from './CommitModal';
import CoworkNotification from './CoworkNotification';
import DeploymentModal from './DeploymentModal';
import DeploymentLogsModal from './DeploymentLogsModal';
import DeploymentSettingsModal from './DeploymentSettingsModal';
import UnlockOptionsModal from './UnlockOptionsModal';
import ClaudeCodeErrorModal from './ClaudeCodeErrorModal';
import ChangelogModal from './ChangelogModal';
import MergeConflictModal from './MergeConflictModal';
import WhatsAppModal from './WhatsAppModal';
import CoworkRepoSettingsModal from './CoworkRepoSettingsModal';
import OrchestratorTab from './OrchestratorTab';
import WikiPanel from './WikiPanel';
import AgentsTab from './AgentsTab';
import { ThemeProvider } from '../ThemeContext';
import type { CoworkRepository, SyncStatus, DeploymentConfig, DeploymentStatus, DeploymentResult, MergeConflict } from '../../shared/types';

export interface Project {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  hasClaudeMd: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  type: 'tools' | 'projekt';
}

let tabCounter = 0;

export default function App() {
  const [navView, setNavView] = useState<NavView>('home');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<{
    imageData: string;
    project: Project;
  } | null>(null);
  const [editorProject, setEditorProject] = useState<Project | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [showLog, setShowLog] = useState<string | null>(null); // null = hidden, '' = all, 'projectName' = filtered
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null); // for type selection
  const [projectInfo, setProjectInfo] = useState<Project | null>(null);
  const [transformProgress, setTransformProgress] = useState<{
    project: Project;
    type: 'tools' | 'projekt';
    step: number;
    completed?: boolean;
    templateSize?: number;
    statusText?: string;
    changes?: string[];
  } | null>(null);
  const [unleashedSettings, setUnleashedSettings] = useState<Record<string, boolean>>({});

  // Coworking state
  const [coworkRepos, setCoworkRepos] = useState<CoworkRepository[]>([]);
  const [coworkSyncStatus, setCoworkSyncStatus] = useState<Record<string, SyncStatus>>({});
  const [addCoworkModal, setAddCoworkModal] = useState(false);
  const [preFlightModal, setPreFlightModal] = useState<CoworkRepository | null>(null);
  const [commitModal, setCommitModal] = useState<{ repo: CoworkRepository; changedFiles: string[] } | null>(null);
  const [dismissedNotifications, setDismissedNotifications] = useState<Set<string>>(new Set());
  const [, setLastRefresh] = useState<Date>(new Date());
  const [coworkLockStatus, setCoworkLockStatus] = useState<Record<string, {
    locked: boolean;
    lock?: { user: string; machine: string; timestamp: string };
    isStale?: boolean;
    isOwnLock?: boolean;
    age?: number;
  }>>({});
  // Track which tabs are associated with cowork repos (tabId -> repoId)
  const [coworkTabMap, setCoworkTabMap] = useState<Record<string, string>>({});
  // Track pending tab close when waiting for commit modal
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // Deployment state
  const [deploymentConfigs, setDeploymentConfigs] = useState<DeploymentConfig[]>([]);
  const [deploymentStatus, setDeploymentStatus] = useState<Record<string, DeploymentStatus>>({});
  const [deploymentModal, setDeploymentModal] = useState<DeploymentConfig | null>(null);
  const [deploymentLogsModal, setDeploymentLogsModal] = useState<DeploymentConfig | null>(null);
  const [deploymentSettingsModal, setDeploymentSettingsModal] = useState<DeploymentConfig | null>(null);
  const [setupDeploymentPath, setSetupDeploymentPath] = useState<string | null>(null);
  const [unlockOptionsModal, setUnlockOptionsModal] = useState<CoworkRepository | null>(null);
  const [mergeConflictModal, setMergeConflictModal] = useState<{ repo: CoworkRepository; conflicts: MergeConflict[] } | null>(null);
  const [closeWorkModal, setCloseWorkModal] = useState<{ repo: CoworkRepository; tabId: string } | null>(null);

  // App info state
  const [appVersion, setAppVersion] = useState<string>('');
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<{
    installed: boolean;
    version?: string;
    path?: string;
    error?: string;
    instructions?: string;
  } | null>(null);
  const [showClaudeCodeError, setShowClaudeCodeError] = useState(false);

  // Update state
  const [updateInfo, setUpdateInfo] = useState<{
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    latestVersion?: string;
    error?: string;
  }>({ checking: false, available: false, downloading: false, progress: 0 });

  // Changelog modal state
  const [showChangelog, setShowChangelog] = useState(false);
  const [lastSeenVersion, setLastSeenVersion] = useState<string | null>(null);

  // WhatsApp state
  const [showWhatsApp, setShowWhatsApp] = useState(false);
  const [whatsAppStatus, setWhatsAppStatus] = useState<{
    connected: boolean;
    ready: boolean;
    phoneNumber?: string;
  }>({ connected: false, ready: false });

  // Cowork repo settings modal state
  const [repoSettingsModal, setRepoSettingsModal] = useState<CoworkRepository | null>(null);

  // Global status for long operations
  const [globalStatus, setGlobalStatus] = useState<string | null>(null);

  // Sub-Agents state
  const [pendingAgentContext, setPendingAgentContext] = useState<{ agentId: string; output: string; projectName: string } | null>(null);
  const [activeAgentCount, setActiveAgentCount] = useState(0);

  // Track active agent count via events
  useEffect(() => {
    const updateCount = () => {
      window.electronAPI?.listAgents().then(agents => {
        if (agents) {
          setActiveAgentCount(agents.filter(a => a.state === 'running' || a.state === 'pending').length);
        }
      });
    };
    updateCount();
    const unsub = window.electronAPI?.onAgentListUpdated(() => updateCount());
    return () => unsub?.();
  }, []);

  useEffect(() => {
    loadProjects();
    loadCoworkRepositories();
    loadDeploymentConfigs();
    loadAppInfo();
    checkForUpdates(true, false); // Silent check on startup, no auto-install
  }, []);

  // Listen for focus-tab events from notifications
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFocusTab((tabId: string) => {
      setActiveTabId(tabId);
    });
    return () => unsubscribe?.();
  }, []);

  // Listen for WhatsApp status changes
  useEffect(() => {
    // Load initial status
    window.electronAPI?.whatsappStatus().then((status) => {
      if (status) setWhatsAppStatus(status);
    });

    // Subscribe to status updates
    const unsubscribe = window.electronAPI?.onWhatsappStatus((status) => {
      setWhatsAppStatus(status);
    });
    return () => unsubscribe?.();
  }, []);

  async function loadAppInfo() {
    const version = await window.electronAPI?.getAppVersion();
    setAppVersion(version || '');
    const status = await window.electronAPI?.checkClaudeCode();
    setClaudeCodeStatus(status || null);

    // Check if we should show changelog
    if (version) {
      const lastSeen = localStorage.getItem('lastSeenVersion');
      setLastSeenVersion(lastSeen);
      if (!lastSeen || compareVersions(version, lastSeen) > 0) {
        // New version, show changelog
        setShowChangelog(true);
      }
    }
  }

  function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.replace(/^v/, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  function handleCloseChangelog() {
    setShowChangelog(false);
    // Save current version as seen
    if (appVersion) {
      localStorage.setItem('lastSeenVersion', appVersion);
      setLastSeenVersion(appVersion);
    }
  }

  async function checkForUpdates(silent = false, autoInstall = true) {
    if (!silent) {
      setUpdateInfo(prev => ({ ...prev, checking: true, error: undefined }));
    }
    try {
      const result = await window.electronAPI?.checkForUpdates();
      if (result) {
        setUpdateInfo(prev => ({
          ...prev,
          checking: false,
          available: result.available,
          latestVersion: result.latestVersion,
          error: result.error,
        }));

        // Auto-install if update available
        if (result.available && autoInstall) {
          console.log('[Update] Auto-installing update...');
          setTimeout(() => downloadAndInstallUpdate(), 1000);
        }
      }
    } catch (err) {
      if (!silent) {
        setUpdateInfo(prev => ({ ...prev, checking: false, error: (err as Error).message }));
      }
    }
  }

  async function downloadAndInstallUpdate() {
    setUpdateInfo(prev => ({ ...prev, downloading: true, progress: 0 }));
    try {
      const result = await window.electronAPI?.downloadUpdate((progress: number) => {
        setUpdateInfo(prev => ({ ...prev, progress }));
      });
      if (result?.success) {
        // App will restart automatically
      } else {
        setUpdateInfo(prev => ({ ...prev, downloading: false, error: result?.error }));
      }
    } catch (err) {
      setUpdateInfo(prev => ({ ...prev, downloading: false, error: (err as Error).message }));
    }
  }

  // Auto-refresh cowork status every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (coworkRepos.length > 0) {
        console.log('Auto-refreshing cowork status...');
        coworkRepos.forEach((repo) => refreshCoworkStatus(repo));
        setLastRefresh(new Date());
        // Clear dismissed notifications on refresh so user sees new changes
        setDismissedNotifications(new Set());
      }
    }, 30 * 1000); // 30 seconds

    return () => clearInterval(interval);
  }, [coworkRepos]);

  // Load unleashed settings for all projects
  useEffect(() => {
    async function loadAllSettings() {
      const settings: Record<string, boolean> = {};
      for (const project of projects) {
        try {
          const projectSettings = await window.electronAPI?.getProjectSettings(project.id);
          if (projectSettings && typeof projectSettings === 'object') {
            // Support both old 'autoAccept' and new 'unleashed' keys for migration
            const ps = projectSettings as { autoAccept?: boolean; unleashed?: boolean };
            settings[project.id] = ps.unleashed ?? ps.autoAccept ?? false;
          }
        } catch {
          // Ignore errors
        }
      }
      setUnleashedSettings(settings);
    }
    if (projects.length > 0) {
      loadAllSettings();
    }
  }, [projects]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+1-9 to select project
      if (e.metaKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        const filtered = filteredProjects;
        if (index < filtered.length) {
          setSelectedProject(filtered[index]);
        }
      }
      // Cmd+K to focus search
      if (e.metaKey && e.key === 'k') {
        e.preventDefault();
        document.getElementById('project-search')?.focus();
      }
      // Cmd+P for quick commands
      if (e.metaKey && e.key === 'p') {
        e.preventDefault();
        setShowQuickCommands(true);
      }
      // Cmd+L for log
      if (e.metaKey && e.key === 'l') {
        e.preventDefault();
        setShowLog(selectedProject?.name || '');
      }
      // Escape to close modals
      if (e.key === 'Escape') {
        if (showLog !== null) {
          setShowLog(null);
        } else if (showQuickCommands) {
          setShowQuickCommands(false);
        } else if (editorProject) {
          setEditorProject(null);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorProject]);

  // Filter projects
  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  async function loadProjects() {
    setLoading(true);
    setGlobalStatus('Projekte werden geladen...');
    try {
      const data = await window.electronAPI?.getProjects();
      setProjects(data || []);
      if (data && data.length > 0 && !selectedProject) {
        setSelectedProject(data[0]);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
    setLoading(false);
    setGlobalStatus(null);
  }

  async function handleAddProject() {
    const folderPath = await window.electronAPI?.selectProjectFolder();
    if (folderPath) {
      setPendingProjectPath(folderPath);
    }
  }

  async function handleSelectProjectType(type: 'tools' | 'projekt') {
    if (!pendingProjectPath) return;
    setGlobalStatus('Projekt wird hinzugefügt...');
    try {
      const newProject = await window.electronAPI?.addProjectWithType(pendingProjectPath, type);
      if (newProject) {
        setProjects((prev) => [...prev, newProject]);
        setSelectedProject(newProject);
      }
    } finally {
      setGlobalStatus(null);
    }
    setPendingProjectPath(null);
  }

  async function handleAddProjectByPath(projectPath: string) {
    setGlobalStatus('Projekt wird hinzugefügt...');
    try {
      const newProject = await window.electronAPI?.addProjectByPath(projectPath);
      if (newProject) {
        setProjects((prev) => [...prev, newProject]);
        setSelectedProject(newProject);
      }
    } finally {
      setGlobalStatus(null);
    }
  }

  async function handleRemoveProject(project: Project) {
    await window.electronAPI?.removeProject(project.path);
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    if (selectedProject?.id === project.id) {
      setSelectedProject(projects.length > 1 ? projects[0] : null);
    }
  }

  async function handleSetProjectType(project: Project, type: 'tools' | 'projekt') {
    const changes: string[] = [];
    const typeName = type === 'tools' ? 'Tools' : 'Projekt';

    // Start transformation
    setTransformProgress({
      project, type, step: 0,
      statusText: 'Scanne Projekt-Dateien...',
      changes: []
    });

    try {
      // Step 1: Check existing project files
      await new Promise((r) => setTimeout(r, 100));
      setTransformProgress({
        project, type, step: 1,
        statusText: 'Prüfe bestehende Dokumentation...',
        changes
      });

      const filesToCheck = ['CONTEXT.md', 'DECISIONS.md', 'STATUS.md'];

      for (const file of filesToCheck) {
        // We just note they exist - they won't be touched
        changes.push(`○ ${file} bleibt unverändert`);
      }

      // Step 2: Load new template
      await new Promise((r) => setTimeout(r, 100));
      setTransformProgress({
        project, type, step: 2,
        statusText: `Lade ${typeName}-Template...`,
        changes: [...changes]
      });

      const template = await window.electronAPI?.getTemplate(type);
      const templateSize = template?.length || 0;

      if (template) {
        changes.push(`✓ ${typeName}-Template geladen (${(templateSize / 1024).toFixed(1)} KB)`);
      } else {
        changes.push('⚠ Kein Template gefunden');
      }

      // Step 3: Save only CLAUDE.md with new template
      await new Promise((r) => setTimeout(r, 100));
      setTransformProgress({
        project, type, step: 3,
        statusText: 'Aktualisiere CLAUDE.md...',
        changes: [...changes]
      });

      const finalContent = template || `# CLAUDE.md\n\nProjekt-Typ: ${typeName}\n`;
      await window.electronAPI?.saveProjectClaudeMd(project.path, finalContent);
      changes.push(`✓ CLAUDE.md aktualisiert (${(finalContent.length / 1024).toFixed(1)} KB)`);

      // Step 4: Update config
      setTransformProgress({
        project, type, step: 3,
        statusText: 'Aktualisiere Konfiguration...',
        changes: [...changes]
      });

      await window.electronAPI?.setProjectType(project.path, type);
      changes.push(`✓ Typ gewechselt → ${typeName}`);

      // Update local state
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, type, hasClaudeMd: true } : p))
      );

      // Show completed summary
      await new Promise((r) => setTimeout(r, 200));
      setTransformProgress({
        project, type, step: 3,
        completed: true,
        templateSize: finalContent.length,
        statusText: 'Fertig!',
        changes: [...changes]
      });
    } catch (error) {
      console.error('Transform error:', error);
      setTransformProgress({
        project, type, step: 0,
        statusText: `Fehler: ${error}`,
        changes: [...changes, `✗ Fehler: ${error}`]
      });
    }
  }

  function handleCloseTransformProgress() {
    setTransformProgress(null);
  }

  async function handleToggleUnleashed(projectId: string, value: boolean) {
    setUnleashedSettings((prev) => ({ ...prev, [projectId]: value }));
    try {
      await window.electronAPI?.saveProjectSettings(projectId, { unleashed: value });
    } catch (err) {
      console.error('Failed to save unleashed setting:', err);
    }
  }

  async function handleAction(action: 'claude' | 'terminal' | 'finder' | 'screenshot' | 'editor' | 'info' | 'wiki', project: Project) {
    if (action === 'finder') {
      window.electronAPI?.openInFinder(project.path);
    } else if (action === 'editor') {
      setEditorProject(project);
    } else if (action === 'info') {
      setProjectInfo(project);
    } else if (action === 'wiki') {
      // Update Obsidian wiki for this project
      setGlobalStatus('Wiki wird aktualisiert...');
      try {
        const result = await window.electronAPI?.updateProjectWiki(project.path, project.id);
        if (result?.success) {
          console.log('Wiki updated successfully');
        } else {
          alert(result?.error || 'Wiki-Update fehlgeschlagen');
        }
      } catch (err) {
        console.error('Wiki update error:', err);
      }
      setGlobalStatus(null);
    } else if (action === 'screenshot') {
      const imageData = await window.electronAPI?.getClipboardImage();
      if (imageData) {
        setScreenshotPreview({ imageData, project });
      } else {
        alert('Kein Bild in der Zwischenablage gefunden!');
      }
    } else {
      // Check if tab for this project already exists
      const existingTab = tabs.find((t) => t.projectPath === project.path);
      if (existingTab) {
        // Switch to existing tab
        setActiveTabId(existingTab.id);
        setSelectedProject(project);
        return;
      }

      // Check Claude Code before starting if action is 'claude'
      if (action === 'claude') {
        const status = await window.electronAPI?.checkClaudeCode();
        setClaudeCodeStatus(status || null);
        if (!status?.installed) {
          setShowClaudeCodeError(true);
          return;
        }
      }

      // Open new tab
      const tabId = `tab-${++tabCounter}`;
      const unleashed = action === 'claude' ? (unleashedSettings[project.id] || false) : false;

      const newTab: Tab = {
        id: tabId,
        projectPath: project.path,
        projectName: project.name,
        runClaude: action === 'claude',
        unleashed,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setSelectedProject(project);
      setNavView('terminal');
    }
  }

  async function handleCloseTab(tabId: string) {
    // Check if this is a cowork tab
    const repoId = coworkTabMap[tabId];
    if (repoId) {
      const repo = coworkRepos.find((r) => r.id === repoId);
      if (repo) {
        // Check for uncommitted changes
        const status = await window.electronAPI?.getCoworkSyncStatus(
          repo.localPath,
          repo.remote,
          repo.branch
        );
        if (status?.hasUncommittedChanges && status.changedFiles.length > 0) {
          // Show commit modal before closing
          setCommitModal({ repo, changedFiles: status.changedFiles });
          // Store the tab to close after commit
          setPendingCloseTabId(tabId);
          return; // Don't close yet, wait for commit modal
        } else {
          // No changes - show dialog to ask about lock
          setCloseWorkModal({ repo, tabId });
          return; // Don't close yet, wait for dialog
        }
      }
    }

    // Not a cowork tab, just close it
    doCloseTab(tabId);
  }

  function doCloseTab(tabId: string) {
    // Clean up tab mapping if it's a cowork tab
    const repoId = coworkTabMap[tabId];
    if (repoId) {
      setCoworkTabMap((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    }

    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
      }
      return newTabs;
    });
  }

  async function handleCloseWorkReleaseLock() {
    if (!closeWorkModal) return;
    const { repo, tabId } = closeWorkModal;

    // Release lock and push
    await window.electronAPI?.releaseCoworkLock(repo.localPath, repo.remote, repo.branch);
    setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));
    refreshCoworkStatus(repo);

    setCloseWorkModal(null);
    doCloseTab(tabId);
  }

  async function handleCloseWorkKeepLock() {
    if (!closeWorkModal) return;
    const { tabId } = closeWorkModal;

    // Just close tab, keep lock
    setCloseWorkModal(null);
    doCloseTab(tabId);
  }

  function handleSelectTab(tabId: string) {
    setActiveTabId(tabId);
  }

  async function handleSaveScreenshot() {
    if (!screenshotPreview) return;
    const { imageData, project } = screenshotPreview;
    const savedPath = await window.electronAPI?.saveScreenshot(project.path, imageData);
    if (savedPath) {
      console.log('Screenshot gespeichert:', savedPath);
    }
    setScreenshotPreview(null);
  }

  function handleCancelScreenshot() {
    setScreenshotPreview(null);
  }

  function handleRunQuickCommand(command: string) {
    setShowQuickCommands(false);
    if (!selectedProject) return;

    // Log the command
    window.electronAPI?.logEntry('command', command, selectedProject.name);

    // Open new terminal tab and run command
    const tabId = `tab-${++tabCounter}`;
    const newTab: Tab = {
      id: tabId,
      projectPath: selectedProject.path,
      projectName: selectedProject.name,
      runClaude: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
    setNavView('terminal');

    // Run command after terminal is ready
    setTimeout(() => {
      window.electronAPI?.ptyWrite(tabId, command + '\r');
    }, 500);
  }

  // Cowork functions
  async function loadCoworkRepositories() {
    setGlobalStatus('Cowork-Repos werden geladen...');
    try {
      const repos = await window.electronAPI?.getCoworkRepositories();
      setCoworkRepos(repos || []);
      // Load sync status for each repo
      if (repos && repos.length > 0) {
        setGlobalStatus(`Status von ${repos.length} Repos wird geprüft...`);
        for (const repo of repos) {
          refreshCoworkStatus(repo);
        }
      }
    } catch (err) {
      console.error('Failed to load cowork repositories:', err);
    } finally {
      // Don't clear status here - refreshCoworkStatus runs async
      setTimeout(() => setGlobalStatus(null), 500);
    }
  }

  async function refreshCoworkStatus(repo: CoworkRepository) {
    try {
      const status = await window.electronAPI?.getCoworkSyncStatus(
        repo.localPath,
        repo.remote,
        repo.branch
      );
      if (status) {
        setCoworkSyncStatus((prev) => ({ ...prev, [repo.id]: status }));
      }
      // Also check lock status
      const lock = await window.electronAPI?.checkCoworkLock(repo.localPath, repo.remote, repo.branch);
      if (lock) {
        setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: lock }));
      }
    } catch (err) {
      console.error('Failed to get cowork status:', err);
    }
  }

  async function handleAddCoworkRepository(repoData: {
    name: string;
    localPath: string;
    githubUrl: string;
    remote: string;
    branch: string;
  }) {
    const result = await window.electronAPI?.addCoworkRepository(repoData);
    if (result?.success && result.repository) {
      const newRepo = result.repository as CoworkRepository;
      setCoworkRepos((prev) => [...prev, newRepo]);
      setAddCoworkModal(false);
      refreshCoworkStatus(newRepo);
    } else {
      alert(result?.error || 'Fehler beim Hinzufügen');
    }
  }

  async function handleRemoveCoworkRepository(repo: CoworkRepository) {
    await window.electronAPI?.removeCoworkRepository(repo.id);
    setCoworkRepos((prev) => prev.filter((r) => r.id !== repo.id));
    setCoworkSyncStatus((prev) => {
      const next = { ...prev };
      delete next[repo.id];
      return next;
    });
  }

  async function handleToggleCoworkUnleashed(repoId: string, value: boolean) {
    // Update local state
    setCoworkRepos((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, unleashed: value } : r))
    );
    // Save to storage
    try {
      await window.electronAPI?.updateCoworkRepoUnleashed(repoId, value);
    } catch (err) {
      console.error('Failed to save cowork unleashed setting:', err);
    }
  }

  function handleOpenRepoSettings(repo: CoworkRepository) {
    setRepoSettingsModal(repo);
  }

  async function handleSaveRepoSettings(repoId: string, settings: {
    wikiVaultPath: string | null;
    wikiProjectEnabled: boolean;
    wikiVaultIndexEnabled: boolean;
  }) {
    // Update local state
    setCoworkRepos((prev) =>
      prev.map((r) => (r.id === repoId ? {
        ...r,
        wikiVaultPath: settings.wikiVaultPath || undefined,
        wikiProjectEnabled: settings.wikiProjectEnabled,
        wikiVaultIndexEnabled: settings.wikiVaultIndexEnabled,
        wikiEnabled: settings.wikiProjectEnabled || settings.wikiVaultIndexEnabled
      } : r))
    );
    // Save to storage
    try {
      await window.electronAPI?.saveCoworkWikiSettings(repoId, settings);
    } catch (err) {
      console.error('Failed to save cowork wiki setting:', err);
    }
  }

  async function handleUpdateCoworkPath(repo: CoworkRepository) {
    const newPath = await window.electronAPI?.selectNewProjectPath();
    if (newPath) {
      const result = await window.electronAPI?.updateCoworkPath(repo.id, newPath);
      if (result?.success) {
        loadCoworkRepositories();
      } else {
        alert(result?.error || 'Fehler beim Aktualisieren des Pfads');
      }
    }
  }

  function handleCoworkSync(repo: CoworkRepository) {
    const status = coworkSyncStatus[repo.id];
    if (status?.hasUncommittedChanges) {
      // Show commit modal
      setCommitModal({ repo, changedFiles: status.changedFiles });
    } else if (status?.state === 'behind') {
      // Auto-pull
      handleCoworkPull(repo);
    } else {
      // Just refresh status
      refreshCoworkStatus(repo);
    }
  }

  async function handleCoworkPull(repo: CoworkRepository) {
    setGlobalStatus(`Pull ${repo.name}...`);
    try {
      const result = await window.electronAPI?.coworkPull(
        repo.localPath,
        repo.remote,
        repo.branch
      );
      if (result?.success) {
        await window.electronAPI?.updateCoworkLastSync(repo.id);
        refreshCoworkStatus(repo);
        // Update lastSync in state
        setCoworkRepos((prev) =>
          prev.map((r) => (r.id === repo.id ? { ...r, lastSync: new Date().toISOString() } : r))
        );
      } else if (result?.conflicts && result.conflicts.length > 0) {
        // Show merge conflict modal
        setMergeConflictModal({ repo, conflicts: result.conflicts });
      } else {
        alert(result?.error || 'Pull fehlgeschlagen');
      }
    } finally {
      setGlobalStatus(null);
    }
  }

  async function handleStartCoworkClaude(repo: CoworkRepository) {
    // Check Claude Code first
    const status = await window.electronAPI?.checkClaudeCode();
    setClaudeCodeStatus(status || null);
    if (!status?.installed) {
      setShowClaudeCodeError(true);
      return;
    }
    setPreFlightModal(repo);
  }

  function handlePreFlightProceed() {
    if (!preFlightModal) return;

    // Check if tab for this cowork repo already exists
    const existingTab = tabs.find((t) => t.projectPath === preFlightModal.localPath);
    if (existingTab) {
      // Switch to existing tab
      setActiveTabId(existingTab.id);
      setPreFlightModal(null);
      return;
    }

    // Open new terminal tab with Claude
    const tabId = `tab-${++tabCounter}`;
    const newTab: Tab = {
      id: tabId,
      projectPath: preFlightModal.localPath,
      projectName: preFlightModal.name,
      runClaude: true,
      unleashed: preFlightModal.unleashed || false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
    setNavView('terminal');
    // Track this tab as a cowork tab
    setCoworkTabMap((prev) => ({ ...prev, [tabId]: preFlightModal.id }));
    // Update last sync and lock status
    window.electronAPI?.updateCoworkLastSync(preFlightModal.id);
    setCoworkRepos((prev) =>
      prev.map((r) => (r.id === preFlightModal.id ? { ...r, lastSync: new Date().toISOString() } : r))
    );
    // Update lock status to show we own it
    setCoworkLockStatus((prev) => ({
      ...prev,
      [preFlightModal.id]: { locked: true, isOwnLock: true }
    }));
    setPreFlightModal(null);
  }

  async function handlePreFlightPullAndProceed() {
    if (!preFlightModal) return;
    // Proceed is handled by PreFlightModal itself after pull
    handlePreFlightProceed();
  }

  async function handleMergeConflictResolved() {
    if (!mergeConflictModal) return;
    const repo = mergeConflictModal.repo;
    // Refresh status after conflict resolution
    await window.electronAPI?.updateCoworkLastSync(repo.id);
    setCoworkRepos((prev) =>
      prev.map((r) => (r.id === repo.id ? { ...r, lastSync: new Date().toISOString() } : r))
    );
    refreshCoworkStatus(repo);
    setMergeConflictModal(null);
  }

  async function handleCommitPush(_message: string) {
    if (!commitModal) return;
    const repo = commitModal.repo;
    const tabIdToClose = pendingCloseTabId;

    // Update last sync
    await window.electronAPI?.updateCoworkLastSync(repo.id);
    setCoworkRepos((prev) =>
      prev.map((r) => (r.id === repo.id ? { ...r, lastSync: new Date().toISOString() } : r))
    );
    refreshCoworkStatus(repo);
    setCommitModal(null);

    // Check if this is from unlock options modal
    if (tabIdToClose?.startsWith('unlock-')) {
      // Just release lock after push
      await window.electronAPI?.releaseCoworkLock(repo.localPath, repo.remote, repo.branch);
      setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));
      refreshCoworkStatus(repo);
      setPendingCloseTabId(null);
      return;
    }

    // Check if this is push + deploy from unlock options modal
    if (tabIdToClose?.startsWith('deploy-')) {
      // Release lock and start deployment
      await window.electronAPI?.releaseCoworkLock(repo.localPath, repo.remote, repo.branch);
      setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));

      // Find and start deployment
      const deployConfig = deploymentConfigs.find(c => c.projectPath === repo.localPath);
      if (deployConfig) {
        setDeploymentModal(deployConfig);
      }

      refreshCoworkStatus(repo);
      setPendingCloseTabId(null);
      return;
    }

    // If we were closing a tab, finish the close now
    if (tabIdToClose) {
      // Release lock
      await window.electronAPI?.releaseCoworkLock(repo.localPath, repo.remote, repo.branch);
      setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));

      // Clean up tab mapping
      setCoworkTabMap((prev) => {
        const next = { ...prev };
        delete next[tabIdToClose];
        return next;
      });

      // Actually close the tab
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabIdToClose);
        if (activeTabId === tabIdToClose) {
          setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
        }
        return newTabs;
      });

      setPendingCloseTabId(null);
    }
  }

  async function handleCommitDiscard() {
    if (!commitModal) return;
    const repo = commitModal.repo;
    const tabIdToClose = pendingCloseTabId;

    setCommitModal(null);

    // If we were closing a tab, finish the close now
    if (tabIdToClose) {
      // Release lock (even though changes are discarded)
      await window.electronAPI?.releaseCoworkLock(repo.localPath, repo.remote, repo.branch);
      setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));

      // Clean up tab mapping
      setCoworkTabMap((prev) => {
        const next = { ...prev };
        delete next[tabIdToClose];
        return next;
      });

      // Actually close the tab
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabIdToClose);
        if (activeTabId === tabIdToClose) {
          setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
        }
        return newTabs;
      });

      setPendingCloseTabId(null);
      refreshCoworkStatus(repo);
    }
  }

  async function handleCommitLater() {
    if (!commitModal) return;
    const tabIdToClose = pendingCloseTabId;

    setCommitModal(null);

    // If we were closing a tab, finish the close but keep the lock
    // The user wants to commit later, so the lock should remain
    if (tabIdToClose) {
      // Clean up tab mapping
      setCoworkTabMap((prev) => {
        const next = { ...prev };
        delete next[tabIdToClose];
        return next;
      });

      // Actually close the tab
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabIdToClose);
        if (activeTabId === tabIdToClose) {
          setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
        }
        return newTabs;
      });

      setPendingCloseTabId(null);
      // Note: Lock remains active so user can return and commit later
    }
  }

  function handleDismissNotification(repoId: string) {
    setDismissedNotifications((prev) => new Set([...prev, repoId]));
  }

  function handleCoworkUnlock(repo: CoworkRepository) {
    // Show unlock options modal instead of directly unlocking
    setUnlockOptionsModal(repo);
  }

  async function handleUnlockJustClose(repo: CoworkRepository) {
    try {
      const result = await window.electronAPI?.releaseCoworkLock(
        repo.localPath,
        repo.remote,
        repo.branch
      );
      if (result?.success) {
        setCoworkLockStatus((prev) => ({ ...prev, [repo.id]: { locked: false } }));
        refreshCoworkStatus(repo);
      } else {
        alert(result?.error || 'Unlock fehlgeschlagen');
      }
    } catch (err) {
      alert((err as Error).message);
    }
    setUnlockOptionsModal(null);
  }

  async function handleUnlockPushAndClose(repo: CoworkRepository) {
    const status = coworkSyncStatus[repo.id];
    if (status?.hasUncommittedChanges && status.changedFiles.length > 0) {
      // Show commit modal with callback to release lock after commit
      setCommitModal({ repo, changedFiles: status.changedFiles });
      // Store a special flag to indicate this came from unlock
      setPendingCloseTabId('unlock-' + repo.id);
    } else {
      // No changes, just release lock
      await handleUnlockJustClose(repo);
    }
    setUnlockOptionsModal(null);
  }

  async function handleUnlockPushDeployAndClose(repo: CoworkRepository) {
    const status = coworkSyncStatus[repo.id];
    const deployConfig = deploymentConfigs.find(c => c.projectPath === repo.localPath);

    if (status?.hasUncommittedChanges && status.changedFiles.length > 0) {
      // Show commit modal first, then deploy
      setCommitModal({ repo, changedFiles: status.changedFiles });
      // Store special flag for deploy after commit
      setPendingCloseTabId('deploy-' + repo.id);
    } else if (deployConfig) {
      // No changes, just deploy and release lock
      setDeploymentModal(deployConfig);
      // Release lock after deployment starts
      await handleUnlockJustClose(repo);
    } else {
      // No deployment config, just release lock
      await handleUnlockJustClose(repo);
    }
    setUnlockOptionsModal(null);
  }

  async function handleNotificationPull(repo: CoworkRepository) {
    const result = await window.electronAPI?.coworkPull(
      repo.localPath,
      repo.remote,
      repo.branch
    );
    if (result?.success) {
      await window.electronAPI?.updateCoworkLastSync(repo.id);
      refreshCoworkStatus(repo);
      setCoworkRepos((prev) =>
        prev.map((r) => (r.id === repo.id ? { ...r, lastSync: new Date().toISOString() } : r))
      );
      // Dismiss after successful pull
      setDismissedNotifications((prev) => new Set([...prev, repo.id]));
    } else {
      alert(result?.error || 'Pull fehlgeschlagen');
    }
  }

  // Deployment functions
  async function loadDeploymentConfigs() {
    try {
      const configs = await window.electronAPI?.getDeploymentConfigs();
      setDeploymentConfigs(configs || []);
      // Load status for each config
      if (configs) {
        for (const config of configs) {
          refreshDeploymentStatus(config);
        }
      }
    } catch (err) {
      console.error('Failed to load deployment configs:', err);
    }
  }

  async function refreshDeploymentStatus(config: DeploymentConfig) {
    try {
      const status = await window.electronAPI?.getDeploymentStatus(config);
      if (status) {
        setDeploymentStatus((prev) => ({ ...prev, [config.id]: status }));
      }
    } catch (err) {
      console.error('Failed to get deployment status:', err);
      setDeploymentStatus((prev) => ({
        ...prev,
        [config.id]: { isOnline: false, containers: [], error: (err as Error).message }
      }));
    }
  }

  async function handleRemoveDeploymentConfig(config: DeploymentConfig) {
    await window.electronAPI?.removeDeploymentConfig(config.id);
    setDeploymentConfigs((prev) => prev.filter((c) => c.id !== config.id));
    setDeploymentStatus((prev) => {
      const next = { ...prev };
      delete next[config.id];
      return next;
    });
  }

  async function handleUpdateDeploymentConfig(config: DeploymentConfig) {
    // Remove old config first, then add updated one
    await window.electronAPI?.removeDeploymentConfig(config.id);
    const result = await window.electronAPI?.addDeploymentConfig(config);
    if (result?.success && result.config) {
      setDeploymentConfigs((prev) => {
        const existing = prev.find(c => c.id === config.id);
        if (existing) {
          return prev.map((c) => c.id === config.id ? result.config! : c);
        } else {
          return [...prev, result.config!];
        }
      });
      refreshDeploymentStatus(result.config);
    } else {
      alert(result?.error || 'Fehler beim Speichern');
    }
  }

  function handleSetupDeployment(repoPath: string) {
    setSetupDeploymentPath(repoPath);
  }

  async function handleTestSshConnection(host: string, user: string, sshKeyPath?: string) {
    return await window.electronAPI?.testSshConnection(host, user, sshKeyPath) || { success: false, error: 'API nicht verfügbar' };
  }

  function handleDeploymentComplete(result: DeploymentResult) {
    if (result.success && deploymentModal) {
      refreshDeploymentStatus(deploymentModal);
    }
  }

  function handleInjectAgentResult(agentId: string, output: string, projectName: string) {
    setPendingAgentContext({ agentId, output, projectName });
    setNavView('orchestrator');
  }

  return (
    <ThemeProvider>
    <div className="app">
      <div className="titlebar">
        <span>Claude MC {appVersion && `v${appVersion}`}</span>
        {claudeCodeStatus && !claudeCodeStatus.installed && (
          <span
            className="claude-status not-installed"
            onClick={() => setShowClaudeCodeError(true)}
            style={{ cursor: 'pointer' }}
            title="Klicken für Installationsanleitung"
          >
            ⚠ Claude Code fehlt
          </span>
        )}
      </div>
      <CoworkNotification
        repositories={coworkRepos}
        syncStatus={coworkSyncStatus}
        onPull={handleNotificationPull}
        onDismiss={handleDismissNotification}
        dismissedRepos={dismissedNotifications}
      />
      <div className="app-body">
        <NavSidebar
          navView={navView}
          setNavView={(view) => {
            setNavView(view);
          }}
          tabCount={tabs.length}
          projectCount={filteredProjects.length}
          coworkCount={coworkRepos.length}
          activeAgentCount={activeAgentCount}
        />
        <div className="app-content">
          {/* Home */}
          {navView === 'home' && (
            <HomeView
              projects={filteredProjects}
              coworkRepos={coworkRepos}
              tabCount={tabs.length}
              activeAgentCount={activeAgentCount}
              onNavigate={setNavView}
              onOpenClaude={(project) => handleAction('claude', project)}
            />
          )}
          {/* Projects */}
          {navView === 'projects' && (
            <ProjectsPanel
              projects={filteredProjects}
              selectedProject={selectedProject}
              onSelectProject={setSelectedProject}
              onAction={handleAction}
              onAddProject={handleAddProject}
              onAddProjectByPath={handleAddProjectByPath}
              onRemoveProject={handleRemoveProject}
              onSetProjectType={handleSetProjectType}
              onShowLog={() => setShowLog('')}
              loading={loading}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              unleashedSettings={unleashedSettings}
              onToggleUnleashed={handleToggleUnleashed}
            />
          )}
          {/* Cowork */}
          {navView === 'cowork' && (
            <CoworkPanel
              coworkRepos={coworkRepos}
              coworkSyncStatus={coworkSyncStatus}
              coworkLockStatus={coworkLockStatus}
              onAddCoworkRepository={() => setAddCoworkModal(true)}
              onRemoveCoworkRepository={handleRemoveCoworkRepository}
              onCoworkSync={handleCoworkSync}
              onStartCoworkClaude={handleStartCoworkClaude}
              onRefreshCoworkStatus={refreshCoworkStatus}
              onCoworkUnlock={handleCoworkUnlock}
              onCoworkReposChanged={loadCoworkRepositories}
              onToggleCoworkUnleashed={handleToggleCoworkUnleashed}
              onOpenRepoSettings={handleOpenRepoSettings}
              onUpdateCoworkPath={handleUpdateCoworkPath}
              deploymentConfigs={deploymentConfigs}
              deploymentStatus={deploymentStatus}
              onDeploy={(config) => setDeploymentModal(config)}
              onShowDeploymentLogs={(config) => setDeploymentLogsModal(config)}
              onRefreshDeploymentStatus={refreshDeploymentStatus}
              onDeploymentConfigsChanged={loadDeploymentConfigs}
              onOpenDeploymentSettings={(config) => setDeploymentSettingsModal(config)}
              onSetupDeployment={handleSetupDeployment}
            />
          )}
          {/* Terminal – always mounted, hidden when not active */}
          <div style={{ display: navView === 'terminal' ? 'contents' : 'none' }}>
            <Terminal
              tabs={tabs}
              activeTabId={activeTabId}
              onCloseTab={handleCloseTab}
              onSelectTab={(tabId) => { handleSelectTab(tabId); setNavView('terminal'); }}
            />
          </div>
          {/* Orchestrator */}
          <div style={{ display: navView === 'orchestrator' ? 'contents' : 'none' }}>
            <OrchestratorTab
              projects={projects}
              coworkRepos={coworkRepos}
              pendingAgentContext={pendingAgentContext}
              onAgentContextConsumed={() => setPendingAgentContext(null)}
              onOpenAgents={() => setNavView('agents')}
            />
          </div>
          {/* Wiki */}
          <div style={{ display: navView === 'wiki' ? 'contents' : 'none' }}>
            <WikiPanel projects={projects} coworkRepos={coworkRepos} />
          </div>
          {/* Agents */}
          <div style={{ display: navView === 'agents' ? 'contents' : 'none' }}>
            <AgentsTab
              projects={projects}
              coworkRepos={coworkRepos}
              onInjectAgentResult={handleInjectAgentResult}
            />
          </div>
        </div>
      </div>
      {screenshotPreview && (
        <ScreenshotPreview
          imageData={screenshotPreview.imageData}
          projectName={screenshotPreview.project.name}
          onSave={handleSaveScreenshot}
          onCancel={handleCancelScreenshot}
        />
      )}
      {editorProject && (
        <EditorPanel
          project={editorProject}
          onClose={() => setEditorProject(null)}
        />
      )}
      {showQuickCommands && (
        <QuickCommands
          onRunCommand={handleRunQuickCommand}
          onClose={() => setShowQuickCommands(false)}
        />
      )}
      {showLog !== null && (
        <LogViewer
          projectFilter={showLog || undefined}
          onClose={() => setShowLog(null)}
        />
      )}
      {pendingProjectPath && (
        <TypeSelector
          onSelect={handleSelectProjectType}
          onCancel={() => setPendingProjectPath(null)}
        />
      )}
      {transformProgress && (
        <ProgressModal
          title={`Wechsle zu ${transformProgress.type === 'tools' ? 'Tools' : 'Projekt'}`}
          steps={[
            'Projekt scannen...',
            'Dokumentation prüfen...',
            'Template laden...',
            'CLAUDE.md aktualisieren...',
          ]}
          currentStep={transformProgress.step}
          completed={transformProgress.completed}
          statusText={transformProgress.statusText}
          changes={transformProgress.changes}
          summary={transformProgress.completed ? {
            projectName: transformProgress.project.name,
            newType: transformProgress.type,
            templateSize: transformProgress.templateSize || 0,
          } : undefined}
          onClose={handleCloseTransformProgress}
        />
      )}
      {projectInfo && (
        <ProjectInfoModal
          project={projectInfo}
          onClose={() => setProjectInfo(null)}
          onProjectUpdated={loadProjects}
        />
      )}
      {addCoworkModal && (
        <AddCoworkRepoModal
          onAdd={handleAddCoworkRepository}
          onCancel={() => setAddCoworkModal(false)}
        />
      )}
      {preFlightModal && (
        <PreFlightModal
          repository={preFlightModal}
          onProceed={handlePreFlightProceed}
          onPullAndProceed={handlePreFlightPullAndProceed}
          onCancel={() => setPreFlightModal(null)}
          onResolveConflicts={(conflicts) => {
            // Close pre-flight modal and open merge conflict modal
            const repo = preFlightModal;
            setPreFlightModal(null);
            setMergeConflictModal({ repo, conflicts });
          }}
        />
      )}
      {commitModal && (
        <CommitModal
          repository={commitModal.repo}
          changedFiles={commitModal.changedFiles}
          onCommitPush={handleCommitPush}
          onDiscard={handleCommitDiscard}
          onLater={handleCommitLater}
        />
      )}
      {deploymentModal && (
        <DeploymentModal
          config={deploymentModal}
          onClose={() => setDeploymentModal(null)}
          onComplete={handleDeploymentComplete}
        />
      )}
      {deploymentLogsModal && (
        <DeploymentLogsModal
          config={deploymentLogsModal}
          onClose={() => setDeploymentLogsModal(null)}
        />
      )}
      {(deploymentSettingsModal || setupDeploymentPath) && (
        <DeploymentSettingsModal
          config={deploymentSettingsModal || undefined}
          projectPath={setupDeploymentPath || undefined}
          onClose={() => {
            setDeploymentSettingsModal(null);
            setSetupDeploymentPath(null);
          }}
          onSave={handleUpdateDeploymentConfig}
          onDelete={deploymentSettingsModal ? handleRemoveDeploymentConfig : undefined}
          onTestConnection={handleTestSshConnection}
        />
      )}
      {unlockOptionsModal && (
        <UnlockOptionsModal
          repository={unlockOptionsModal}
          syncStatus={coworkSyncStatus[unlockOptionsModal.id]}
          deploymentConfig={deploymentConfigs.find(c => c.projectPath === unlockOptionsModal.localPath)}
          onPushAndClose={() => handleUnlockPushAndClose(unlockOptionsModal)}
          onJustClose={() => handleUnlockJustClose(unlockOptionsModal)}
          onPushDeployAndClose={() => handleUnlockPushDeployAndClose(unlockOptionsModal)}
          onCancel={() => setUnlockOptionsModal(null)}
        />
      )}
      {mergeConflictModal && (
        <MergeConflictModal
          conflicts={mergeConflictModal.conflicts}
          repoPath={mergeConflictModal.repo.localPath}
          onResolved={handleMergeConflictResolved}
          onCancel={() => setMergeConflictModal(null)}
        />
      )}
      {showClaudeCodeError && claudeCodeStatus && !claudeCodeStatus.installed && (
        <ClaudeCodeErrorModal
          instructions={claudeCodeStatus.instructions || 'Claude Code ist nicht installiert.'}
          onClose={() => setShowClaudeCodeError(false)}
          onRetry={async () => {
            const status = await window.electronAPI?.checkClaudeCode();
            setClaudeCodeStatus(status || null);
            if (status?.installed) {
              setShowClaudeCodeError(false);
            }
          }}
        />
      )}
      {showChangelog && appVersion && (
        <ChangelogModal
          currentVersion={appVersion}
          lastSeenVersion={lastSeenVersion}
          onClose={handleCloseChangelog}
        />
      )}
      {closeWorkModal && (
        <div className="modal-overlay" onClick={() => setCloseWorkModal(null)}>
          <div className="modal close-work-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Arbeit beenden?</h3>
            <p>Möchtest du den Lock für <strong>{closeWorkModal.repo.name}</strong> freigeben?</p>
            <p className="modal-hint">Andere können erst arbeiten, wenn der Lock freigegeben ist.</p>
            <div className="modal-buttons">
              <button className="btn-primary" onClick={handleCloseWorkReleaseLock}>
                Lock freigeben
              </button>
              <button className="btn-secondary" onClick={handleCloseWorkKeepLock}>
                Lock behalten
              </button>
              <button className="btn-cancel" onClick={() => setCloseWorkModal(null)}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}
      <StatusBar
        appVersion={appVersion}
        activeProject={selectedProject}
        claudeCodeStatus={claudeCodeStatus}
        whatsAppStatus={whatsAppStatus}
        updateInfo={updateInfo}
        globalStatus={globalStatus}
        onShowWhatsApp={() => setShowWhatsApp(true)}
        onCheckForUpdates={() => checkForUpdates(false)}
        onInstallUpdate={downloadAndInstallUpdate}
      />
      {showWhatsApp && (
        <WhatsAppModal onClose={() => setShowWhatsApp(false)} />
      )}
      {repoSettingsModal && (
        <CoworkRepoSettingsModal
          repo={repoSettingsModal}
          onClose={() => setRepoSettingsModal(null)}
          onSave={handleSaveRepoSettings}
        />
      )}
    </div>
    </ThemeProvider>
  );
}
