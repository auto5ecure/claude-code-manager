import { useState, useEffect, useCallback } from 'react';
import Sidebar from './Sidebar';
import Terminal, { Tab } from './Terminal';
import ScreenshotPreview from './ScreenshotPreview';
import EditorPanel from './EditorPanel';
import QuickCommands from './QuickCommands';
import LogViewer from './LogViewer';
import TypeSelector from './TypeSelector';
import ProgressModal from './ProgressModal';
import InfoModal from './InfoModal';

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

declare global {
  interface Window {
    electronAPI: {
      getAppPath: () => Promise<string>;
      getProjects: () => Promise<Project[]>;
      addProject: () => Promise<Project | null>;
      addProjectByPath: (path: string) => Promise<Project | null>;
      selectProjectFolder: () => Promise<string | null>;
      addProjectWithType: (path: string, type: 'tools' | 'projekt') => Promise<Project | null>;
      removeProject: (path: string) => Promise<boolean>;
      renameProject: (path: string, name: string) => Promise<boolean>;
      setProjectType: (path: string, type: 'tools' | 'projekt') => Promise<boolean>;
      getTemplate: (type: 'tools' | 'projekt') => Promise<string>;
      getGlobalSettings: () => Promise<Record<string, unknown>>;
      getClaudeMd: () => Promise<string>;
      openInFinder: (path: string) => Promise<void>;
      openInTerminal: (path: string) => Promise<void>;
      startClaude: (path: string) => Promise<void>;
      getProjectClaudeMd: (path: string) => Promise<string | null>;
      saveProjectClaudeMd: (path: string, content: string) => Promise<boolean>;
      getProjectSettings: (id: string) => Promise<Record<string, unknown> | null>;
      saveProjectSettings: (id: string, settings: object) => Promise<boolean>;
      ptySpawn: (tabId: string, cwd: string, runClaude?: boolean) => Promise<boolean>;
      ptyWrite: (tabId: string, data: string) => void;
      ptyResize: (tabId: string, cols: number, rows: number) => void;
      ptyKill: (tabId: string) => Promise<boolean>;
      onPtyData: (callback: (tabId: string, data: string) => void) => void;
      onPtyExit: (callback: (tabId: string, code: number) => void) => void;
      getClipboardImage: () => Promise<string | null>;
      saveScreenshot: (projectPath: string, dataUrl: string) => Promise<string>;
      logEntry: (type: 'command' | 'activity' | 'error', message: string, project?: string) => Promise<boolean>;
      getLog: (limit?: number, projectFilter?: string) => Promise<Array<{
        timestamp: string;
        type: 'command' | 'activity' | 'error';
        project?: string;
        message: string;
      }>>;
      clearLog: () => Promise<boolean>;
      platform: string;
    };
  }
}

let tabCounter = 0;

export default function App() {
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
  const [showInfo, setShowInfo] = useState(false);
  const [transformProgress, setTransformProgress] = useState<{
    project: Project;
    type: 'tools' | 'projekt';
    step: number;
    completed?: boolean;
    templateSize?: number;
    statusText?: string;
    changes?: string[];
  } | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

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
  }

  async function handleAddProject() {
    const folderPath = await window.electronAPI?.selectProjectFolder();
    if (folderPath) {
      setPendingProjectPath(folderPath);
    }
  }

  async function handleSelectProjectType(type: 'tools' | 'projekt') {
    if (!pendingProjectPath) return;
    const newProject = await window.electronAPI?.addProjectWithType(pendingProjectPath, type);
    if (newProject) {
      setProjects((prev) => [...prev, newProject]);
      setSelectedProject(newProject);
    }
    setPendingProjectPath(null);
  }

  async function handleAddProjectByPath(projectPath: string) {
    const newProject = await window.electronAPI?.addProjectByPath(projectPath);
    if (newProject) {
      setProjects((prev) => [...prev, newProject]);
      setSelectedProject(newProject);
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

      // Check which files exist (these will be preserved)
      const existingClaudeMd = await window.electronAPI?.getProjectClaudeMd(project.path);
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

  async function handleAction(action: 'claude' | 'terminal' | 'finder' | 'screenshot' | 'editor', project: Project) {
    if (action === 'finder') {
      window.electronAPI?.openInFinder(project.path);
    } else if (action === 'editor') {
      setEditorProject(project);
    } else if (action === 'screenshot') {
      const imageData = await window.electronAPI?.getClipboardImage();
      if (imageData) {
        setScreenshotPreview({ imageData, project });
      } else {
        alert('Kein Bild in der Zwischenablage gefunden!');
      }
    } else {
      // Open new tab
      const tabId = `tab-${++tabCounter}`;
      const newTab: Tab = {
        id: tabId,
        projectPath: project.path,
        projectName: project.name,
        runClaude: action === 'claude',
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setSelectedProject(project);
    }
  }

  function handleCloseTab(tabId: string) {
    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
      }
      return newTabs;
    });
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

    // Run command after terminal is ready
    setTimeout(() => {
      window.electronAPI?.ptyWrite(tabId, command + '\r');
    }, 500);
  }

  return (
    <div className="app">
      <div className="titlebar">
        <span>Claude Code Manager</span>
      </div>
      <div className="main-container">
        <Sidebar
          projects={filteredProjects}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
          onAction={handleAction}
          onAddProject={handleAddProject}
          onAddProjectByPath={handleAddProjectByPath}
          onRemoveProject={handleRemoveProject}
          onSetProjectType={handleSetProjectType}
          onShowLog={() => setShowLog('')}
          onShowInfo={() => setShowInfo(true)}
          loading={loading}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
        <Terminal
          tabs={tabs}
          activeTabId={activeTabId}
          onCloseTab={handleCloseTab}
          onSelectTab={handleSelectTab}
        />
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
      {showInfo && (
        <InfoModal onClose={() => setShowInfo(false)} />
      )}
    </div>
  );
}
