/**
 * Hook for project lifecycle operations.
 *
 * Manages: project selection/opening, back-to-projects, project creation/import,
 * dev server restart, compact mode entry, GitHub status refresh,
 * preview readiness, terminal interactions, and auto-accept mode.
 *
 * @module hooks/useProjectLifecycle
 */

import { useState, useRef, useCallback, type RefObject } from 'react';
import type { DevServerHandle, Project } from '../lib/project';
import type { ProjectType } from '../lib/static-server';
import type { ProjectGitHubStatus } from '../lib/github';
import { getAutoAcceptMode, setAutoAcceptMode as setAutoAcceptModeApi } from '../lib/project';
import { getProjectGitHubStatus } from '../lib/github';
import { GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';
import { registerExternalProject } from '../lib/external-projects';
import {
  setWindowTitle,
  getWindowLabel,
  findAndReservePort,
  releaseReservedPort,
  getProjectWindow,
  focusWindowByLabel,
} from '../lib/window';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent, trackError } from '../lib/analytics';

import type { AppView } from '../lib/types';

/** Preferred port for Next.js dev server (will find available port if taken) */
const PREFERRED_DEV_SERVER_PORT = 3000;

export interface UseProjectLifecycleParams {
  currentProject: Project | null;
  setCurrentProject: (project: Project | null) => void;
  currentProjectPathRef: RefObject<string | null>;
  setView: (view: AppView | ((prev: AppView) => AppView)) => void;
  // Dev server
  devServerRef: RefObject<DevServerHandle | null>;
  devServerPort: number;
  setDevServerPort: (port: number) => void;
  startServerForProject: (
    projectPath: string,
    projectName: string,
    port: number,
    windowLabel: string
  ) => Promise<ProjectType>;
  stopServer: () => Promise<void>;
  restartDevServer: (projectPath: string, portOverride?: number) => Promise<void>;
  enterCompact: (port: number) => Promise<void>;
  // Terminal
  resetTerminals: () => void;
  pasteToActiveTerminal: (text: string) => void;
  // Toast
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  // Screenshot
  clearScreenshotInterval: () => void;
  startScreenshotInterval: (projectPath: string) => void;
  onPreviewReady: (projectPath: string) => void;
  // Layout
  setShowDevServerLogs: (show: boolean) => void;
  setWorkspaceTab: (tab: 'preview' | 'branches' | 'prs') => void;
  resetLayout: () => void;
  // Integrations
  setProjectGitHubStatus: (status: ProjectGitHubStatus | null) => void;
  clearProjectStatuses: () => void;
  // Branches
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  clearBranchState: () => void;
  // Plugin
  checkPluginSuggestion: (projectPath: string) => Promise<void>;
}

export function useProjectLifecycle({
  currentProject,
  setCurrentProject,
  currentProjectPathRef,
  setView,
  devServerRef,
  devServerPort,
  setDevServerPort,
  startServerForProject,
  stopServer,
  restartDevServer,
  enterCompact,
  resetTerminals,
  pasteToActiveTerminal,
  showToast,
  clearScreenshotInterval,
  startScreenshotInterval,
  onPreviewReady,
  setShowDevServerLogs,
  setWorkspaceTab,
  resetLayout,
  setProjectGitHubStatus,
  clearProjectStatuses,
  fetchBranchInfo,
  clearBranchState,
  checkPluginSuggestion,
}: UseProjectLifecycleParams) {
  // Auto-accept mode for the terminal agent
  const [autoAcceptMode, setAutoAcceptMode] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Import project view: 'none' | 'picker' | 'github'
  const [importView, setImportView] = useState<'none' | 'picker' | 'github'>('none');

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState('/');

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);
  // Force publish dropdown to open (triggered by Save button in BranchIndicator) - trigger mode
  const [forcePublishOpen, setForcePublishOpen] = useState(false);
  // Compact publish dropdown state - controlled mode for toggle behavior via the compact Publish button
  const [isCompactPublishOpen, setIsCompactPublishOpen] = useState(false);

  // Auto-accept warning modal state
  const [showAutoAcceptWarning, setShowAutoAcceptWarning] = useState(false);

  // Track project path currently being opened to prevent concurrent opens (race condition guard)
  const openingProjectPathRef = useRef<string | null>(null);

  // Send prompt to Claude terminal
  const sendToClaude = useCallback(
    (prompt: string) => {
      pasteToActiveTerminal(prompt);
    },
    [pasteToActiveTerminal]
  );

  // Handle terminal exit (memoized to prevent re-spawning agent on every render)
  const handleTerminalExit = useCallback((code: number | null) => {
    logger.info('Terminal exited', { code });
  }, []);

  // Handle toolbar auto-accept toggle
  const handleToolbarAutoAcceptToggle = useCallback(() => {
    if (!autoAcceptMode) {
      // Turning ON — always show confirmation
      setShowAutoAcceptWarning(true);
      return;
    }
    // Turning OFF — no confirmation needed
    setAutoAcceptMode(false);
    if (currentProject) {
      void setAutoAcceptModeApi(currentProject.path, false);
    }
  }, [autoAcceptMode, currentProject]);

  const handleAutoAcceptWarningAccept = useCallback(() => {
    setAutoAcceptMode(true);
    setShowAutoAcceptWarning(false);
    if (currentProject) {
      void setAutoAcceptModeApi(currentProject.path, true);
    }
  }, [currentProject]);

  // Handle preview server ready wrapper
  const handlePreviewReady = useCallback(() => {
    if (currentProject) {
      onPreviewReady(currentProject.path);
    }
  }, [currentProject, onPreviewReady]);

  const handleSelectProject = async (project: Project) => {
    const windowLabel = getWindowLabel();
    const totalStart = performance.now();
    let stepStart = performance.now();

    logger.info(`[OpenProject] Starting: ${project.name}`, { windowLabel });
    void trackEvent('project_opened', {
      project_name: project.name,
      project_path: project.path,
      $screen_name: 'Workspace',
    });

    // Guard against concurrent opens for the same project (race condition prevention)
    if (openingProjectPathRef.current === project.path) {
      logger.info(`[OpenProject] Already opening ${project.name}, skipping duplicate call`);
      return;
    }
    openingProjectPathRef.current = project.path;

    // Check if project is already open in another window
    try {
      const existingWindow = await getProjectWindow(project.path);
      if (existingWindow && existingWindow !== windowLabel) {
        logger.info(`[OpenProject] Project already open in window ${existingWindow}, focusing`);
        try {
          await focusWindowByLabel(existingWindow);
          openingProjectPathRef.current = null; // Clear guard before return
          return; // Successfully focused existing window
        } catch (focusError) {
          // Window no longer exists (stale data), proceed with opening locally
          logger.info(`[OpenProject] Window ${existingWindow} no longer exists, opening locally`, {
            focusError: focusError instanceof Error ? focusError.message : String(focusError),
          });
        }
      }
    } catch (e) {
      logger.warn('[OpenProject] Failed to check for existing window', { error: e });
    }

    // Register this window's project to prevent duplicate windows
    try {
      await invoke('register_project_for_window', {
        windowLabel,
        projectPath: project.path,
      });
    } catch (e) {
      logger.warn('[OpenProject] Failed to register project for window', { error: e });
    }

    // Stop any existing dev server first
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }
    logger.info(
      `[OpenProject] Step 1: Stop existing dev server - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Kill any process on our ACTUALLY reserved port (query backend, don't use stale React state)
    // This prevents HMR reload from killing other windows' ports when state resets to 3000
    stepStart = performance.now();
    const actualReservedPort = await invoke<number | null>('get_reserved_port_for_window', {
      windowLabel,
    });
    if (actualReservedPort !== null) {
      try {
        await invoke('kill_port', { port: actualReservedPort });
      } catch {
        // Ignore errors - port may already be free
      }
    }
    logger.info(
      `[OpenProject] Step 2: Kill reserved port ${actualReservedPort ?? 'none'} - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Clean up PTY processes owned by this window (not other windows' PTYs)
    stepStart = performance.now();
    try {
      await invoke('kill_window_pty', { windowLabel: getWindowLabel() });
      await invoke('cleanup_orphaned_processes');
    } catch {
      // Ignore cleanup errors
    }
    logger.info(
      `[OpenProject] Step 3: Kill PTY and cleanup orphaned processes - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Load saved dev server port preference
    stepStart = performance.now();
    let preferredPort = PREFERRED_DEV_SERVER_PORT;
    try {
      const savedPort = await invoke<number | null>('get_dev_server_port', {
        projectPath: project.path,
      });
      if (savedPort && savedPort >= 1 && savedPort <= 65535) {
        preferredPort = savedPort;
      }
    } catch {
      // Fall back to default — metadata might not exist yet
    }
    logger.info(
      `[OpenProject] Step 4a: Load saved port preference (${preferredPort}) - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Find and reserve an available port for this window (prevents race conditions in multi-window)
    stepStart = performance.now();
    let port = preferredPort;
    try {
      // Release any previously reserved port for this window before getting a new one
      await releaseReservedPort().catch(() => {});
      port = await findAndReservePort(preferredPort);
    } catch (error) {
      logger.error('Failed to find and reserve port, using default', { error });
    }
    // Kill any orphaned process on the newly reserved port (e.g. from a previous crashed session)
    try {
      await invoke('kill_port', { port });
    } catch {
      // Ignore - port may already be free
    }
    logger.info(
      `[OpenProject] Step 4: Reserved port ${port} (killed orphans) - ${Math.round(performance.now() - stepStart)}ms`
    );
    setDevServerPort(port);

    // Clear any existing screenshot interval
    clearScreenshotInterval();

    // Reset publishing state when switching projects
    setIsPublishing(false);

    // Kill all terminals and reset tabs
    resetTerminals();
    setShowDevServerLogs(false);

    setCurrentProject(project);
    setCurrentPreviewPage('/');
    currentProjectPathRef.current = project.path;

    // Store project path for HMR recovery (critical for main window which doesn't have initialProjectPath)
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    sessionStorage.setItem(storageKey, project.path);

    setView('project-loading');

    // Set window title to include project name
    void setWindowTitle(`Ship Studio - ${project.name}`).catch((error) => {
      logger.error('Failed to set window title', { error });
    });

    // Fetch auto-accept mode preference for this project
    stepStart = performance.now();
    try {
      const autoAccept = await getAutoAcceptMode(project.path);
      setAutoAcceptMode(autoAccept);
    } catch {
      setAutoAcceptMode(false);
    }
    logger.info(
      `[OpenProject] Step 5: Fetch auto-accept mode - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Mark project as opened (for sorting by last opened)
    void invoke('mark_project_opened', { projectPath: project.path }).catch((err) =>
      logger.warn('Failed to mark project as opened', { error: err })
    );

    // Ensure .shipstudio/ is gitignored (backwards compat for existing projects)
    void invoke('ensure_gitignore_has_shipstudio', { projectPath: project.path }).catch((err) =>
      logger.warn('Failed to ensure gitignore', { error: err })
    );

    // Fetch branch info (needed for UI before showing workspace)
    stepStart = performance.now();
    await fetchBranchInfo(project.path);
    logger.info(
      `[OpenProject] Step 6: Fetch branch info - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Detect project type and start appropriate server
    stepStart = performance.now();
    const detectedType = await startServerForProject(project.path, project.name, port, windowLabel);
    logger.info(
      `[OpenProject] Step 7: Start dev server - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Generic projects don't have a web preview — default to branches tab
    if (detectedType === 'generic') {
      setWorkspaceTab('branches');
    }

    setView('workspace');
    logger.info(`[OpenProject] Complete - Total: ${Math.round(performance.now() - totalStart)}ms`);

    // Fetch GitHub status in background (non-blocking for faster perceived load)
    void getProjectGitHubStatus(project.path)
      .catch(() => GITHUB_STATUS_FALLBACK)
      .then((ghStatus) => {
        setProjectGitHubStatus(ghStatus);
      });

    // Capture screenshots periodically
    startScreenshotInterval(project.path);

    // Suggest Vercel plugin if project has .vercel config but plugin isn't installed
    void checkPluginSuggestion(project.path);

    // Clear the guard after completion
    openingProjectPathRef.current = null;
  };

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleProjectCreated = (projectPath: string) => {
    setShowCreateModal(false);
    const projectName = projectPath.split('/').pop() || 'project';
    void trackEvent('project_created', {
      project_name: projectName,
      source: 'new',
      $screen_name: 'Create Project',
    });
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportProject = () => {
    setImportView('picker');
  };

  const handleProjectImported = (projectPath: string) => {
    setImportView('none');
    const projectName = projectPath.split('/').pop() || 'project';
    void trackEvent('project_imported', {
      project_name: projectName,
      source: 'github',
      $screen_name: 'Import Project',
    });
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportLocalFolder = async () => {
    setImportView('none');
    try {
      const path = await registerExternalProject();
      if (path) {
        const projectName = path.split('/').pop() || 'project';
        void trackEvent('project_imported', {
          project_name: projectName,
          source: 'local_folder',
          $screen_name: 'Import Project',
        });
        void handleSelectProject({ name: projectName, path, thumbnail: null });
      }
    } catch (error) {
      trackError('local_folder_import', error, 'Dashboard');
      showToast(String(error), 'error');
    }
  };

  const handleBackToProjects = async () => {
    // Mark that user explicitly went back to projects - this prevents auto-open from
    // firing again even after HMR reloads (survives page refresh)
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    sessionStorage.removeItem(storageKey);
    sessionStorage.setItem(dismissedKey, 'true');

    // Unregister this window from the project registry so "Open in New Window"
    // will create a fresh window instead of focusing this one (which is now showing projects)
    try {
      await invoke('unregister_project_from_window', { windowLabel });
    } catch {
      // Ignore - non-critical
    }

    // Clear screenshot interval and project ref
    clearScreenshotInterval();
    currentProjectPathRef.current = null;

    // Reset publishing and auto-accept state
    setIsPublishing(false);
    setAutoAcceptMode(false);

    // Clear branch state
    clearBranchState();

    // Kill all terminals and reset tabs
    resetTerminals();
    resetLayout();

    // Stop dev server or static server
    await stopServer();
    const currentWindowLabel = getWindowLabel();

    // Clean up PTY processes owned by this window
    try {
      await invoke('kill_window_pty', { windowLabel: currentWindowLabel });
      await invoke('cleanup_orphaned_processes');
      // Query backend for the actual reserved port (don't rely on potentially stale React state)
      const actualPort = await invoke<number | null>('get_reserved_port_for_window', {
        windowLabel: currentWindowLabel,
      });
      if (actualPort !== null) {
        await invoke('kill_port', { port: actualPort });
      }
    } catch {
      // Ignore cleanup errors
    }

    setCurrentProject(null);
    clearProjectStatuses();
    setView('projects');

    // Reset window title when closing project
    void setWindowTitle('Ship Studio').catch(console.error);
  };

  const handleRestartDevServer = async () => {
    if (!currentProject) return;
    await restartDevServer(currentProject.path);
  };

  // Compact mode handler wrapper
  const handleEnterCompactMode = async () => {
    try {
      await enterCompact(devServerPort);
    } catch {
      showToast('Failed to enter compact mode', 'error');
    }
  };

  const handleGitHubStatusChange = () => {
    // Refresh project GitHub status after push/publish
    if (currentProject) {
      void getProjectGitHubStatus(currentProject.path)
        .catch(() => GITHUB_STATUS_FALLBACK)
        .then((status) => setProjectGitHubStatus(status));
    }
  };

  return {
    // State
    autoAcceptMode,
    setAutoAcceptMode,
    showCreateModal,
    setShowCreateModal,
    importView,
    setImportView,
    setCurrentPreviewPage,
    isPublishing,
    setIsPublishing,
    forcePublishOpen,
    setForcePublishOpen,
    isCompactPublishOpen,
    setIsCompactPublishOpen,
    showAutoAcceptWarning,
    setShowAutoAcceptWarning,
    // Handlers
    handleSelectProject,
    handleBackToProjects,
    handleProjectCreated,
    handleImportProject,
    handleProjectImported,
    handleImportLocalFolder,
    handleCreateProject,
    handleRestartDevServer,
    handleEnterCompactMode,
    handleGitHubStatusChange,
    handlePreviewReady,
    sendToClaude,
    handleTerminalExit,
    handleToolbarAutoAcceptToggle,
    handleAutoAcceptWarningAccept,
  };
}
