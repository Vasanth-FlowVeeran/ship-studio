/**
 * Main application component and state management.
 *
 * This is the root component that orchestrates:
 * - Application views (loading, setup, projects, workspace)
 * - Project management (opening, creating, dev server lifecycle)
 * - Terminal and preview panel coordination
 * - Periodic screenshot capture for thumbnails
 * - Git branch management and status polling
 *
 * ## State Architecture
 *
 * Some state has been extracted into custom hooks for better organization:
 * - `useToasts` - Toast notification state (self-contained, no dependencies)
 * - `useTerminalManagement` - Terminal tabs and session state (self-contained)
 * - `useIntegrationStatus` - GitHub/Vercel/Claude integration state (complex reducer)
 *
 * The following state intentionally remains in App.tsx:
 * - **Git/Branch state** (currentBranch, branches, openPRs, etc.) - Tightly coupled
 *   with project lifecycle, preview refresh, and health panel. Extracting would
 *   require passing multiple refs and callbacks, adding complexity without benefit.
 * - **Dev server state** (devServerRef, devServerPort, etc.) - Fundamentally tied
 *   to project open/close lifecycle in handleSelectProject/handleBackToProjects.
 * - **UI state** (modals, dropdowns, compact mode) - Simple boolean flags that
 *   don't benefit from extraction.
 *
 * @module App
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useToasts } from './hooks/useToasts';
import { useTerminalManagement } from './hooks/useTerminalManagement';
import {
  useIntegrationStatus,
  GITHUB_STATUS_FALLBACK,
  VERCEL_STATUS_FALLBACK,
} from './hooks/useIntegrationStatus';
import { Terminal, ClaudeStatus } from './components/Terminal';
import { DevServerLogs } from './components/DevServerLogs';
import { Preview, PreviewHandle } from './components/Preview';
import { ProjectList } from './components/ProjectList';
import { CreateProject } from './components/CreateProject';
import { ImportProject } from './components/ImportProject';
import { ImportTypePicker } from './components/ImportTypePicker';
import { registerExternalProject } from './lib/external-projects';
import { Changelog } from './components/Changelog';
import { OnboardingScreen, OnboardingTerminal } from './components/setup';
import { SplitPane } from './components/SplitPane';
import { GitHubButton } from './components/GitHubButton';
import { VercelButton } from './components/VercelButton';
import { PublishBranchDropdown } from './components/PublishBranchDropdown';
import { EnvEditor } from './components/EnvEditor';
import { AssetsPanel } from './components/AssetsPanel';
import { BranchIndicator } from './components/BranchIndicator';
import { BranchesTab } from './components/BranchesTab';
import { PullRequestsTab } from './components/PullRequestsTab';
import { GitErrorHandler } from './components/GitErrorHandler';
import { SubmitReviewModal } from './components/SubmitReviewModal';
import { ConflictResolutionModal } from './components/ConflictResolutionModal';
import { BugReportButton } from './components/BugReportButton';
import { CompactActionsRow } from './components/CompactMode';
import { MainBranchBanner } from './components/MainBranchBanner';
import { BrowserDropdown } from './components/BrowserDropdown';
import { ConnectOverlay } from './components/ConnectOverlay';
import { CodeHealthPanel, CodeHealthPanelRef } from './components/CodeHealthPanel';
import { ScreenshotToast, ScreenshotPreviewModal } from './components/ScreenshotPreview';
import { NotificationSettingsModal } from './components/NotificationSettingsModal';
import { HelpModal } from './components/HelpModal';
import { BackupsModal } from './components/BackupsModal';
import { SkillsModal } from './components/SkillsModal';
import { EducationOverlay } from './components/EducationOverlay';
import {
  NotificationSettings,
  loadNotificationSettings,
  saveNotificationSettings,
  playSound,
} from './lib/sounds';
import './styles/notifications.css';
import {
  BranchInfo,
  PullRequestInfo,
  listBranches,
  listPullRequests,
  getCurrentBranch,
  switchBranch,
  pullAndMerge,
} from './lib/branches';
import {
  CodeIcon,
  CameraIcon,
  CropIcon,
  FullPageIcon,
  SuccessIcon,
  InfoIcon,
  CloseIcon,
  VSCodeIcon,
  CursorIcon,
  BranchIcon,
  PullRequestIcon,
  EyeIcon,
  PanelRightIcon,
  PlusIcon,
  ImageIcon,
  TerminalIcon,
  ResetIcon,
  CompactIcon,
  PinIcon,
  ExpandIcon,
  ArrowLeftIcon,
  HelpIcon,
  GraduationCapIcon,
  ZapIcon,
  BellIcon,
  ActivityIcon,
  HistoryIcon,
  DollarIcon,
} from './components/icons';
import { startDevServer, Project, DevServerHandle, getAutoAcceptMode } from './lib/project';
import { getProjectGitHubStatus } from './lib/github';
import { getChangedFiles, ChangedFile } from './lib/git';
import { getProjectVercelStatus } from './lib/vercel';
import {
  enterCompactMode,
  exitCompactMode,
  setAlwaysOnTop,
  focusWindow,
  setWindowTitle,
  getWindowLabel,
  findAndReservePort,
  releaseReservedPort,
  getProjectWindow,
  focusWindowByLabel,
} from './lib/window';
import { getFullSetupStatus, quickSetupCheck, markSetupComplete } from './lib/setup';
import { UpdateBanner } from './components/UpdateBanner';
import { invoke } from '@tauri-apps/api/core';
import { logger } from './lib/logger';
import './styles/index.css';

// Initialize logger
logger.init();

/** Interval between automatic screenshot captures (5 minutes) */
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** Delay after page load before capturing screenshot (8 seconds to allow Next.js/Vite to fully compile) */
const SCREENSHOT_DELAY_MS = 8000;
/** Maximum number of retry attempts for thumbnail capture */
const SCREENSHOT_MAX_RETRIES = 5;
/** Delay between retry attempts (3 seconds) */
const SCREENSHOT_RETRY_DELAY_MS = 3000;
/** Preferred port for Next.js dev server (will find available port if taken) */
const PREFERRED_DEV_SERVER_PORT = 3000;

/** Current application view/screen */
type AppView = 'loading' | 'onboarding' | 'projects' | 'project-loading' | 'workspace';

/** Props for the App component */
interface AppProps {
  /** Initial project path from URL parameter (for multi-window support) */
  initialProjectPath?: string | null;
}

function App({ initialProjectPath }: AppProps) {
  const [view, setView] = useState<AppView>('loading');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [autoAcceptMode, setAutoAcceptMode] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const devServerRef = useRef<DevServerHandle | null>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const screenshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);
  // Capture session ID - incremented when project changes, used to cancel pending captures
  const captureSessionIdRef = useRef<number>(0);
  // Track if auto-open has been attempted this session (protects against StrictMode double-invoke)
  const autoOpenAttemptedRef = useRef(false);
  // Track project path currently being opened to prevent concurrent opens (race condition guard)
  const openingProjectPathRef = useRef<string | null>(null);

  // Terminal tabs management
  const {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    terminalRefsMap,
    maxTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    resetTerminals,
    focusActiveTerminal,
    pasteToActiveTerminal,
  } = useTerminalManagement();

  // Compact mode state - starts false, set to true when Compact button is clicked
  const [isPinned, setIsPinned] = useState(false);

  // Auto-unpin when window is resized to full mode width
  useEffect(() => {
    const COMPACT_BREAKPOINT = 550;

    const handleResize = () => {
      // If window is wider than compact breakpoint and still pinned, auto-unpin
      if (window.innerWidth > COMPACT_BREAKPOINT && isPinned) {
        setIsPinned(false);
        setAlwaysOnTop(false).catch((error) => {
          logger.error('Failed to auto-unpin window', { error });
        });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isPinned]);

  // Cleanup dev server when window is closed (prevents orphaned processes)
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Stop the dev server synchronously as best we can
      if (devServerRef.current) {
        try {
          devServerRef.current.pty.kill();
        } catch {
          // Ignore errors during cleanup
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Dev server logs state
  const [showDevServerLogs, setShowDevServerLogs] = useState(false);
  const devServerOutputRef = useRef<string>(''); // Buffer output for when logs tab opens
  const [devServerOutputVersion, setDevServerOutputVersion] = useState(0); // Triggers re-render when output changes

  // Health check logs state
  const [showHealthLogs, setShowHealthLogs] = useState(false);
  const healthOutputRef = useRef<string>(''); // Buffer health check output
  const [healthOutputVersion, setHealthOutputVersion] = useState(0); // Triggers re-render when output changes
  const healthPanelRef = useRef<CodeHealthPanelRef>(null);

  // Notification settings state
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(loadNotificationSettings);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);

  // Integration states consolidated via reducer for atomic updates
  const {
    integrations,
    isInitialCheckDone,
    refreshVercelStatus,
    refreshAllCliStatuses,
    setProjectGitHubStatus,
    setProjectVercelStatus,
    clearProjectStatuses,
    authTerminalConfig,
    handleGitHubConnect: handleGitHubConnectFromOverlay,
    handleVercelConnect: handleVercelConnectFromOverlay,
    handleAuthTerminalExit,
    closeAuthTerminal,
  } = useIntegrationStatus();

  // Capture state for screenshot button
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const [isCropCapturing, setIsCropCapturing] = useState(false);
  const [isFullPageCapturing, setIsFullPageCapturing] = useState(false);

  // Screenshot preview state
  const [screenshotPreviewPath, setScreenshotPreviewPath] = useState<string | null>(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);

  // Dev server port (dynamically assigned to avoid conflicts)
  const [devServerPort, setDevServerPort] = useState(PREFERRED_DEV_SERVER_PORT);

  // Dev server restart state
  const [isRestartingDevServer, setIsRestartingDevServer] = useState(false);

  // Env editor modal
  const [showEnvEditor, setShowEnvEditor] = useState(false);

  // Backups modal
  const [showBackupsModal, setShowBackupsModal] = useState(false);

  // Assets panel modal
  const [showAssetsPanel, setShowAssetsPanel] = useState(false);

  // Education mode
  const [isEducationMode, setIsEducationMode] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Import project view: 'none' | 'picker' | 'github'
  const [importView, setImportView] = useState<'none' | 'picker' | 'github'>('none');

  // IDE dropdown
  const [showIdeDropdown, setShowIdeDropdown] = useState(false);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  const [openingIde, setOpeningIde] = useState<string | null>(null);

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState('/');

  // Toast notifications
  const { toasts, showToast, dismissToast } = useToasts();

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);
  // Force publish dropdown to open (triggered by Save button in BranchIndicator) - trigger mode
  const [forcePublishOpen, setForcePublishOpen] = useState(false);
  // Compact publish dropdown state - controlled mode for toggle behavior via the compact Publish button
  const [isCompactPublishOpen, setIsCompactPublishOpen] = useState(false);

  // Vercel auto-connecting state (when linking after GitHub repo creation)
  const [isVercelAutoConnecting, setIsVercelAutoConnecting] = useState(false);

  // Branch management state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [openPRs, setOpenPRs] = useState<PullRequestInfo[]>([]);
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [showSubmitReview, setShowSubmitReview] = useState<string | null>(null);
  const [isBranchSwitching, setIsBranchSwitching] = useState(false);
  const [gitError, setGitError] = useState<{
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null>(null);

  // Conflict resolution modal state
  const [showConflictResolution, setShowConflictResolution] = useState(false);

  // Help modal state
  const [showHelpModal, setShowHelpModal] = useState(false);

  // Skills modal state
  const [showSkillsModal, setShowSkillsModal] = useState(false);

  // Workspace tab state (preview/branches/prs)
  const [workspaceTab, setWorkspaceTab] = useState<'preview' | 'branches' | 'prs'>('preview');

  // Compact mode view state - what to show in compact mode (terminal, branches, or prs)
  const [compactView, setCompactView] = useState<'terminal' | 'branches' | 'prs'>('terminal');

  // Preview panel visibility
  const [isPreviewHidden, setIsPreviewHidden] = useState(false);

  // Reset to preview tab if on branches/prs and GitHub is not connected
  useEffect(() => {
    if (integrations.projectGithub?.status !== 'connected') {
      if (workspaceTab !== 'preview') {
        setWorkspaceTab('preview');
      }
      if (compactView !== 'terminal') {
        setCompactView('terminal');
      }
    }
  }, [integrations.projectGithub?.status, workspaceTab, compactView]);

  // Check IDE availability on mount
  useEffect(() => {
    void invoke<{ vscode: boolean; cursor: boolean }>('check_ide_availability')
      .then(setIdeAvailability)
      .catch(() => setIdeAvailability({ vscode: false, cursor: false }));
  }, []);

  // Keyboard shortcut for help modal (Cmd+/ or F1)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+/ (Mac) or Ctrl+/ (Windows) or F1
      if (((e.metaKey || e.ctrlKey) && e.key === '/') || e.key === 'F1') {
        e.preventDefault();
        setShowHelpModal(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Open project in IDE
  const openInIde = async (ide: 'vscode' | 'cursor') => {
    if (!currentProject) return;
    setOpeningIde(ide);
    try {
      await invoke('open_in_ide', { projectPath: currentProject.path, ide });
      // Command completed (IDE process spawned), reset state
      // Dropdown closes naturally when user moves mouse away
      setOpeningIde(null);
    } catch (e) {
      logger.error(`Failed to open in ${ide}`, { error: e });
      setOpeningIde(null);
    }
  };

  const checkSetup = useCallback(async (forceFullCheck = false) => {
    setView('loading');
    try {
      // Fast path: if setup was previously completed, try quick check first
      if (!forceFullCheck) {
        const quickCheck = await quickSetupCheck();
        if (quickCheck.setupCompleteCached && quickCheck.allPresent) {
          // Setup was completed before and all binaries still exist
          // Show projects immediately, verify auth in background
          // Use functional update to avoid overwriting HMR recovery's 'workspace' view
          setView((currentView) =>
            currentView === 'loading' || currentView === 'onboarding' ? 'projects' : currentView
          );
          void verifySetupInBackground();
          return;
        }
      }

      // Slow path: full setup check (first launch or something missing)
      const setupStatus = await getFullSetupStatus();

      // Check and set all CLI states atomically
      await refreshAllCliStatuses();

      // Use full setup status to determine if onboarding is needed
      if (setupStatus.allReady) {
        // Persist setup complete for existing users upgrading to this version
        // (they already completed onboarding but don't have the cached state yet)
        void markSetupComplete();
        // Use functional update to avoid overwriting HMR recovery's 'workspace' view
        setView((currentView) =>
          currentView === 'loading' || currentView === 'onboarding' ? 'projects' : currentView
        );
      } else {
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Failed to check prerequisites', { error });
      setView('onboarding');
    }
  }, []);

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  // HMR Recovery for ALL windows (main window and project windows)
  // Checks backend port reservation to detect HMR and restore UI state without restarting dev server
  // This runs BEFORE the auto-open effect and handles the "already have a project open" case
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const storedProjectPath = sessionStorage.getItem(storageKey);
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    // Skip if already in workspace view (state already correct)
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Skip if ref says we've already handled this (prevents double-invoke in StrictMode)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Skip if user explicitly went back to projects
    if (dismissedValue === 'true') {
      return;
    }

    // Check backend for existing port reservation (most reliable HMR indicator)
    void (async () => {
      try {
        const existingPort = await invoke<number | null>('get_reserved_port_for_window', {
          windowLabel,
        });

        // If we have a reserved port, this is likely an HMR reload
        if (existingPort !== null && storedProjectPath) {
          // Mark as handled to prevent the auto-open effect from also firing
          autoOpenAttemptedRef.current = true;

          logger.info('[HMR Recovery] Port reserved, restoring UI state', {
            windowLabel,
            port: existingPort,
            projectPath: storedProjectPath,
          });

          // Restore UI state without restarting dev server
          const projectName = storedProjectPath.split('/').pop() || 'Project';
          setCurrentProject({
            name: projectName,
            path: storedProjectPath,
            thumbnail: null,
          });
          setDevServerPort(existingPort);
          setView('workspace');

          // Refresh branch info and statuses in background
          // Dispatch each independently so fast results aren't blocked by slow ones
          void fetchBranchInfo(storedProjectPath);
          void getProjectGitHubStatus(storedProjectPath)
            .catch(() => GITHUB_STATUS_FALLBACK)
            .then((status) => setProjectGitHubStatus(status));
          void getProjectVercelStatus(storedProjectPath)
            .catch(() => VERCEL_STATUS_FALLBACK)
            .then((status) => setProjectVercelStatus(status));
        }
      } catch {
        // If backend check fails, let normal flow continue
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchBranchInfo is stable, don't re-run on change
  }, [view]);

  // Auto-open project if initialProjectPath is provided (multi-window support)
  // This handles the case where a NEW project window is opened (not HMR recovery)
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    if (!initialProjectPath) {
      return;
    }

    // Skip if HMR recovery already handled this (ref is set by the HMR recovery effect)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Check if user explicitly went back to projects - don't auto-open again
    if (dismissedValue === 'true') {
      return;
    }

    // Skip if already in workspace view
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Only auto-open when we reach projects or loading view
    if (view === 'projects' || view === 'loading') {
      // Mark as attempted BEFORE any async work to prevent races
      autoOpenAttemptedRef.current = true;

      // Store the project path for HMR recovery (before any async work)
      sessionStorage.setItem(storageKey, initialProjectPath);

      const projectName = initialProjectPath.split('/').pop() || 'Project';
      const project: Project = {
        name: projectName,
        path: initialProjectPath,
        thumbnail: null,
      };
      logger.info('[MultiWindow] Auto-opening project from URL param', {
        path: initialProjectPath,
      });
      void handleSelectProject(project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSelectProject is stable, don't re-run on change
  }, [initialProjectPath, view]);

  // Background verification for optimistic loading
  const verifySetupInBackground = async () => {
    try {
      // Full verification of auth status
      await refreshAllCliStatuses();

      // Check if any auth is now missing
      const setupStatus = await getFullSetupStatus();
      if (!setupStatus.allReady) {
        // Something is no longer configured - redirect to onboarding
        const missingItems = setupStatus.items
          .filter((i) => i.status !== 'ready')
          .map((i) => i.friendlyName);
        logger.warn('Background verification found missing setup items', { missingItems });
        // Redirect to onboarding to fix the issues
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Background setup verification failed', { error });
    }
  };

  // Handle capture for Claude - screenshot preview and paste path into terminal
  const handleCaptureForClaude = useCallback(async () => {
    if (isCapturing || !previewRef.current) return;

    setIsCapturing(true);
    try {
      const filePath = await previewRef.current.captureForClaude();
      if (filePath) {
        // Quote path if it contains spaces
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        // Show screenshot preview toast
        setScreenshotPreviewPath(filePath);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, pasteToActiveTerminal]);

  // Handle full page capture - screenshot entire scrollable page and paste path into terminal
  const handleCaptureFullPage = useCallback(async () => {
    if (isFullPageCapturing || !previewRef.current) return;

    setIsFullPageCapturing(true);
    try {
      const filePath = await previewRef.current.captureFullPage();
      if (filePath) {
        // Quote path if it contains spaces
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        // Show screenshot preview toast
        setScreenshotPreviewPath(filePath);
      }
    } finally {
      setIsFullPageCapturing(false);
    }
  }, [isFullPageCapturing, pasteToActiveTerminal]);

  // Handle crop mode start - show loading state
  const handleCropStart = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(true);
  }, []);

  // Handle crop mode completion - paste path into terminal
  const handleCropComplete = useCallback(
    (filePath: string | null) => {
      setIsCropCapturing(false);
      if (filePath) {
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        // Show screenshot preview toast
        setScreenshotPreviewPath(filePath);
      }
    },
    [pasteToActiveTerminal]
  );

  // Handle crop mode cancel
  const handleCropCancel = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(false);
  }, []);

  // Fetch branch info for a project
  const fetchBranchInfo = useCallback(async (projectPath: string) => {
    try {
      const [branch, branchList] = await Promise.all([
        getCurrentBranch(projectPath).catch(() => null),
        listBranches(projectPath).catch(() => []),
      ]);
      setCurrentBranch(branch);
      setBranches(branchList);

      // Fetch open PRs for branch status display (non-blocking)
      void listPullRequests(projectPath)
        .then((prs) => setOpenPRs(prs.filter((pr) => pr.state === 'OPEN')))
        .catch(() => setOpenPRs([]));

      // Check for uncommitted changes using the backend
      void invoke<boolean>('check_git_has_changes', { projectPath })
        .then((hasChanges) => setHasUncommittedChanges(hasChanges))
        .catch(() => setHasUncommittedChanges(false));
    } catch (e) {
      logger.error('Failed to fetch branch info', { error: e });
      setCurrentBranch(null);
      setBranches([]);
    }
  }, []);

  // Check git status (called periodically to sync with CLI changes)
  const checkGitStatus = useCallback(
    async (projectPath: string) => {
      try {
        const [branch, hasChanges, files] = await Promise.all([
          getCurrentBranch(projectPath).catch(() => null),
          invoke<boolean>('check_git_has_changes', { projectPath }).catch(() => false),
          getChangedFiles(projectPath).catch(() => []),
        ]);

        // Update branch if changed (e.g., user switched via CLI)
        if (branch && branch !== currentBranch) {
          setCurrentBranch(branch);
          // Refresh full branch list when branch changes
          void listBranches(projectPath)
            .then(setBranches)
            .catch(() => {});
        }

        setHasUncommittedChanges(hasChanges);
        setChangedFiles(files);
      } catch (e) {
        // Silently ignore errors during periodic checks
        logger.warn('Error checking git status', { error: e });
      }
    },
    [currentBranch]
  );

  // Periodically check git status when a project is open and window is focused
  useEffect(() => {
    if (!currentProject?.path) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      // Check immediately when starting/resuming
      void checkGitStatus(currentProject.path);
      // Then check every 3 seconds
      interval = setInterval(() => {
        void checkGitStatus(currentProject.path);
      }, 3000);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    // Start polling if window is visible
    if (!document.hidden) {
      startPolling();
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentProject?.path, checkGitStatus]);

  // Handle branch switch
  const handleBranchSwitch = useCallback(
    async (branchName: string) => {
      setIsBranchSwitching(true);
      setCurrentBranch(branchName);
      // Reset uncommitted changes immediately - will be updated by fetchBranchInfo
      setHasUncommittedChanges(false);
      if (currentProject) {
        await fetchBranchInfo(currentProject.path);
      }
      // Refresh preview after Next.js has time to detect file changes and rebuild
      setTimeout(() => previewRef.current?.refresh(), 300);
      setTimeout(() => {
        previewRef.current?.refresh();
        setIsBranchSwitching(false);
      }, 2500);
      // Run health checks after branch switch (give files time to settle)
      setTimeout(() => {
        void healthPanelRef.current?.refreshScripts();
        void healthPanelRef.current?.runAllChecks();
      }, 1000);
    },
    [currentProject, fetchBranchInfo]
  );

  // Handle publish error
  const handlePublishError = useCallback(
    (error: string, errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic') => {
      if (currentBranch) {
        setGitError({
          errorType,
          message: error,
          branchName: currentBranch,
        });
      }
    },
    [currentBranch]
  );

  // Handle opening conflict resolution modal
  // For PR conflicts: switch to head branch, merge base branch, then show UI
  const handleResolveConflicts = useCallback(
    async (headBranch?: string, baseBranch?: string) => {
      setGitError(null);

      if (!currentProject) return;

      // If we have branch info, we're resolving PR conflicts
      if (headBranch && baseBranch) {
        try {
          showToast('Preparing to resolve conflicts...', 'success');

          // Switch to the PR's head branch
          const switchResult = await switchBranch(currentProject.path, headBranch, true);
          if (!switchResult.success) {
            showToast(switchResult.error || 'Failed to switch branch', 'error');
            return;
          }

          // Update current branch state
          setCurrentBranch(headBranch);

          // Merge the base branch to create conflicts locally
          try {
            await pullAndMerge(currentProject.path, baseBranch);
            // If merge succeeds without conflicts, we're done
            showToast('Branch is up to date, no conflicts!', 'success');
            void fetchBranchInfo(currentProject.path);
            return;
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            if (errorMsg.includes('MERGE_CONFLICT')) {
              // Conflicts created locally - show the UI
              setShowConflictResolution(true);
            } else {
              showToast(`Failed to merge: ${errorMsg}`, 'error');
            }
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          showToast(`Error: ${errorMsg}`, 'error');
        }
      } else {
        // Direct conflict resolution (e.g., from GitErrorHandler after a failed push)
        setShowConflictResolution(true);
      }
    },
    [currentProject, showToast, fetchBranchInfo]
  );

  // Handle conflict resolution completed
  const handleConflictsResolved = useCallback(() => {
    setShowConflictResolution(false);
    if (currentProject) {
      void fetchBranchInfo(currentProject.path);
    }
  }, [currentProject, fetchBranchInfo]);

  // Send prompt to Claude terminal
  const sendToClaude = useCallback(
    (prompt: string) => {
      pasteToActiveTerminal(prompt);
    },
    [pasteToActiveTerminal]
  );

  // Handle health check output
  const handleHealthOutput = useCallback((output: string) => {
    healthOutputRef.current += output;
    // Limit buffer size to prevent memory issues
    if (healthOutputRef.current.length > 100000) {
      healthOutputRef.current = healthOutputRef.current.slice(-100000);
    }
    setHealthOutputVersion((v) => v + 1);
  }, []);

  // Handle terminal exit (memoized to prevent re-spawning Claude on every render)
  const handleTerminalExit = useCallback((code: number | null) => {
    logger.info('Terminal exited', { code });
  }, []);

  // Track previous Claude status to detect transitions
  const prevClaudeStatusRef = useRef<ClaudeStatus>('idle');

  // Use ref for notification settings to avoid re-creating callback
  const notificationSettingsRef = useRef(notificationSettings);
  useEffect(() => {
    notificationSettingsRef.current = notificationSettings;
  }, [notificationSettings]);

  // Handle Claude status changes - play sounds based on settings
  const handleClaudeStatusChange = useCallback((status: ClaudeStatus, _title: string) => {
    const settings = notificationSettingsRef.current;
    const wasThinking = prevClaudeStatusRef.current === 'thinking';

    // When Claude transitions from thinking to waiting (finished processing)
    if (wasThinking && status === 'waiting' && settings.enabled) {
      void playSound(settings.sound);
    }

    prevClaudeStatusRef.current = status;
  }, []);

  // Save notification settings when they change
  const handleSaveNotificationSettings = useCallback((settings: NotificationSettings) => {
    setNotificationSettings(settings);
    saveNotificationSettings(settings);
  }, []);

  // Capture project screenshot in background (only if dev server is ready)
  // Includes retry logic for cases where the server is still compiling
  // Uses sessionId to cancel pending captures when project changes
  const captureScreenshot = useCallback(
    async (projectPath: string, sessionId: number, attempt: number = 1) => {
      // Check if this capture session is still valid (project hasn't changed)
      if (captureSessionIdRef.current !== sessionId) {
        logger.info('[Thumbnail] Skipping - session cancelled (project changed)', {
          expectedSession: sessionId,
          currentSession: captureSessionIdRef.current,
        });
        return;
      }
      // Skip capture if the preview server isn't ready (avoids "localhost cannot connect" thumbnails)
      if (!previewRef.current?.isServerReady()) {
        logger.info('[Thumbnail] Skipping - dev server not ready');
        return;
      }
      // Verify the current project matches the one we're trying to capture
      // This prevents capturing the wrong content during project switches
      if (currentProjectPathRef.current !== projectPath) {
        logger.info('[Thumbnail] Skipping - project mismatch', {
          expected: projectPath,
          current: currentProjectPathRef.current,
        });
        return;
      }
      try {
        logger.info('[Thumbnail] Capturing now', {
          projectPath,
          port: devServerPort,
          attempt,
          sessionId,
        });
        await invoke('capture_project_thumbnail', {
          projectPath,
          url: `http://localhost:${devServerPort}`,
        });
        logger.info('Thumbnail captured successfully', { projectPath, attempt });
      } catch (error) {
        // Double-check session is still valid before scheduling retry
        if (captureSessionIdRef.current !== sessionId) {
          logger.info('[Thumbnail] Skipping retry - session cancelled');
          return;
        }
        // Retry if the server isn't responding yet (still compiling)
        if (attempt < SCREENSHOT_MAX_RETRIES) {
          logger.info('[Thumbnail] Capture failed, will retry', {
            error,
            attempt,
            maxRetries: SCREENSHOT_MAX_RETRIES,
            retryInMs: SCREENSHOT_RETRY_DELAY_MS,
          });
          setTimeout(() => {
            void captureScreenshot(projectPath, sessionId, attempt + 1);
          }, SCREENSHOT_RETRY_DELAY_MS);
        } else {
          logger.error('Failed to capture thumbnail after retries', {
            error,
            attempts: attempt,
          });
        }
      }
    },
    [devServerPort]
  );

  // Handle preview server ready - capture initial screenshot
  // Increments session ID to cancel any pending captures from previous attempts
  const handlePreviewReady = useCallback(() => {
    if (currentProject) {
      // Increment session ID to cancel any pending captures from previous calls
      const sessionId = ++captureSessionIdRef.current;
      logger.info('[Thumbnail] Preview ready, scheduling capture', {
        projectPath: currentProject.path,
        sessionId,
        delayMs: SCREENSHOT_DELAY_MS,
      });
      setTimeout(() => {
        void captureScreenshot(currentProject.path, sessionId);
      }, SCREENSHOT_DELAY_MS);
    }
  }, [currentProject, captureScreenshot]);

  const handleSelectProject = async (project: Project) => {
    const windowLabel = getWindowLabel();
    const totalStart = performance.now();
    let stepStart = performance.now();

    logger.info(`[OpenProject] Starting: ${project.name}`, { windowLabel });

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

    // Find and reserve an available port for this window (prevents race conditions in multi-window)
    stepStart = performance.now();
    let port = PREFERRED_DEV_SERVER_PORT;
    try {
      // Release any previously reserved port for this window before getting a new one
      await releaseReservedPort().catch(() => {});
      port = await findAndReservePort(PREFERRED_DEV_SERVER_PORT);
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
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }

    // Reset publishing and auto-connecting state when switching projects
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);

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
    void invoke('mark_project_opened', { projectPath: project.path }).catch(() => {});

    // Ensure .shipstudio/ is gitignored (backwards compat for existing projects)
    void invoke('ensure_gitignore_has_shipstudio', { projectPath: project.path }).catch(() => {});

    // Fetch branch info (needed for UI before showing workspace)
    stepStart = performance.now();
    await fetchBranchInfo(project.path);
    logger.info(
      `[OpenProject] Step 6: Fetch branch info - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Start dev server in background on the available port
    stepStart = performance.now();
    try {
      // Clear previous output buffers
      devServerOutputRef.current = '';
      setDevServerOutputVersion(0);
      healthOutputRef.current = '';
      setHealthOutputVersion(0);
      devServerRef.current = await startDevServer(project.path, port, windowLabel, (data) => {
        // Buffer output from the start so it's available when Logs tab opens
        devServerOutputRef.current += data;
        // Limit buffer size to prevent memory issues (keep last 100KB)
        if (devServerOutputRef.current.length > 100000) {
          devServerOutputRef.current = devServerOutputRef.current.slice(-100000);
        }
        // Trigger re-render for DevServerLogs (throttled by React)
        setDevServerOutputVersion((v) => v + 1);
      });
    } catch (error) {
      logger.error('Failed to start dev server', { error });
    }
    logger.info(
      `[OpenProject] Step 7: Start dev server - ${Math.round(performance.now() - stepStart)}ms`
    );

    setView('workspace');
    logger.info(`[OpenProject] Complete - Total: ${Math.round(performance.now() - totalStart)}ms`);

    // Fetch GitHub and Vercel status in background (non-blocking for faster perceived load)
    // Dispatch each independently so fast results (e.g. GitHub ~300ms) aren't blocked by slow ones (e.g. Vercel ~30s+)
    void getProjectGitHubStatus(project.path)
      .catch(() => GITHUB_STATUS_FALLBACK)
      .then((ghStatus) => {
        setProjectGitHubStatus(ghStatus);
      });
    void getProjectVercelStatus(project.path)
      .catch(() => VERCEL_STATUS_FALLBACK)
      .then((vcStatus) => {
        logger.info('[OpenProject] Vercel status received', {
          project: project.name,
          status: vcStatus.status,
          project_name: vcStatus.project_name,
          production_url: vcStatus.production_url,
          staging_url: vcStatus.staging_url,
        });
        setProjectVercelStatus(vcStatus);
      });

    // Capture screenshots periodically - check ref to avoid stale closure
    const projectPath = project.path;
    screenshotIntervalRef.current = setInterval(() => {
      // Only capture if this is still the current project
      if (currentProjectPathRef.current === projectPath) {
        // Use current session ID for periodic captures (not incrementing)
        void captureScreenshot(projectPath, captureSessionIdRef.current);
      }
    }, SCREENSHOT_INTERVAL_MS);

    // Clear the guard after completion
    openingProjectPathRef.current = null;
  };

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleProjectCreated = (projectPath: string) => {
    setShowCreateModal(false);
    const projectName = projectPath.split('/').pop() || 'project';
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportProject = () => {
    setImportView('picker');
  };

  const handleProjectImported = (projectPath: string) => {
    setImportView('none');
    const projectName = projectPath.split('/').pop() || 'project';
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportLocalFolder = async () => {
    setImportView('none');
    try {
      const path = await registerExternalProject();
      if (path) {
        const projectName = path.split('/').pop() || 'project';
        void handleSelectProject({ name: projectName, path, thumbnail: null });
      }
    } catch (error) {
      alert(String(error));
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
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }
    currentProjectPathRef.current = null;
    // Cancel any pending screenshot captures by incrementing session ID
    captureSessionIdRef.current++;

    // Reset publishing, auto-connecting, and auto-accept state
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);
    setAutoAcceptMode(false);

    // Clear branch state
    setCurrentBranch(null);
    setBranches([]);
    setHasUncommittedChanges(false);
    setChangedFiles([]);

    // Kill all terminals and reset tabs
    resetTerminals();
    setShowDevServerLogs(false);

    // Stop dev server if running
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }

    // Clean up PTY processes owned by this window
    const currentWindowLabel = getWindowLabel();
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

    setIsRestartingDevServer(true);

    // Helper to add timeout to async operations to prevent infinite hangs
    const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);
    };

    // Helper for delays
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      // Stop current dev server if it exists (5s timeout)
      if (devServerRef.current) {
        try {
          await withTimeout(devServerRef.current.stop(), 5000, undefined);
        } catch (e) {
          logger.warn('Error stopping dev server, continuing with restart', { error: e });
        }
        devServerRef.current = null;
      }

      // Clear output buffers for fresh logs
      devServerOutputRef.current = '';
      setDevServerOutputVersion(0);
      healthOutputRef.current = '';
      setHealthOutputVersion(0);

      // Small delay to let the PTY cleanup complete
      await delay(500);

      // Kill any lingering process on the port (5s timeout)
      try {
        await withTimeout(invoke('kill_port', { port: devServerPort }), 5000, undefined);
      } catch {
        // Ignore if nothing to kill
      }

      // Another small delay after port kill
      await delay(300);

      // Clear project cache - can be slow for large .next folders (10s timeout)
      try {
        await withTimeout(
          invoke('clear_project_cache', { projectPath: currentProject.path }),
          10000,
          undefined
        );
      } catch {
        // Non-critical - continue even if cache clear fails
      }

      // Start new dev server (10s timeout for the spawn setup, not the server itself)
      devServerRef.current = await withTimeout(
        startDevServer(currentProject.path, devServerPort, getWindowLabel(), (data) => {
          devServerOutputRef.current += data;
          if (devServerOutputRef.current.length > 100000) {
            devServerOutputRef.current = devServerOutputRef.current.slice(-100000);
          }
          setDevServerOutputVersion((v) => v + 1);
        }),
        10000,
        null as unknown as DevServerHandle
      );

      if (!devServerRef.current) {
        logger.error('Failed to start dev server: spawn timed out');
      }
    } catch (error) {
      logger.error('Failed to restart dev server', { error });
    } finally {
      setIsRestartingDevServer(false);
    }
  };

  // Compact mode handler - resizes window, opens browser, enables always-on-top
  // The UI adapts to narrow width via responsive CSS
  const handleEnterCompactMode = async () => {
    // Exit education mode since it doesn't work in compact mode
    setIsEducationMode(false);

    try {
      // Resize window to compact dimensions + enable always-on-top
      await enterCompactMode();
      setIsPinned(true); // Sync state since enterCompactMode enables always-on-top

      // Small delay to let the window settle, then open browser
      setTimeout(() => {
        void (async () => {
          try {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await openUrl(`http://localhost:${devServerPort}`);

            // After browser opens, wait a bit then refocus the compact window
            setTimeout(() => {
              void focusWindow().catch((error) => {
                logger.error('Failed to refocus window', { error });
              });
            }, 500);
          } catch (error) {
            logger.error('Failed to open browser', { error });
          }
        })();
      }, 100);
    } catch (error) {
      logger.error('Failed to enter compact mode', { error });
      showToast('Failed to enter compact mode', 'error');
    }
  };

  // Toggle always-on-top in compact mode
  const handlePinToggle = useCallback(async () => {
    const newPinned = !isPinned;
    setIsPinned(newPinned);
    try {
      await setAlwaysOnTop(newPinned);
    } catch (error) {
      logger.error('Failed to toggle always on top', { error });
      setIsPinned(!newPinned); // Revert on failure
    }
  }, [isPinned]);

  // Exit compact mode and expand to full window
  const handleExpandToFull = useCallback(async () => {
    try {
      await exitCompactMode();
      setIsPinned(true); // Reset pin state for next compact mode entry
    } catch (error) {
      logger.error('Failed to exit compact mode', { error });
    }
  }, []);

  const handleGitHubStatusChange = async (vercelDeployedUrl?: string) => {
    // Refresh project GitHub and Vercel status after push/publish
    if (currentProject) {
      // If we have a vercel deployed URL, optimistically set Vercel as connected
      // This avoids race conditions where the status check runs before Vercel's state propagates
      if (vercelDeployedUrl) {
        const ghStatus = await getProjectGitHubStatus(currentProject.path).catch(
          () => GITHUB_STATUS_FALLBACK
        );
        setProjectGitHubStatus(ghStatus);
        setProjectVercelStatus({
          status: 'connected',
          project_name: currentProject.name,
          production_url: vercelDeployedUrl.replace(/^https?:\/\//, ''),
          staging_url: null,
          vercel_org: null,
        });
        return;
      }

      // Dispatch each independently so fast results aren't blocked by slow ones
      void getProjectGitHubStatus(currentProject.path)
        .catch(() => GITHUB_STATUS_FALLBACK)
        .then((status) => setProjectGitHubStatus(status));
      void getProjectVercelStatus(currentProject.path)
        .catch(() => VERCEL_STATUS_FALLBACK)
        .then((status) => setProjectVercelStatus(status));
    }
  };

  const handleVercelStatusChange = async (deployedUrl?: string) => {
    // If we have a deployed URL from a successful deployment, use it directly
    if (deployedUrl && currentProject) {
      setProjectVercelStatus({
        status: 'connected',
        project_name: currentProject.name,
        production_url: deployedUrl,
        staging_url: integrations.projectVercel?.staging_url ?? null,
        vercel_org: integrations.projectVercel?.vercel_org ?? null,
      });
      return;
    }
    // Otherwise refresh project Vercel status
    if (currentProject) {
      const status = await getProjectVercelStatus(currentProject.path).catch(
        () => VERCEL_STATUS_FALLBACK
      );
      setProjectVercelStatus(status);
    }
  };

  if (view === 'loading') {
    return (
      <>
        <div className="app loading">
          <img src="/ship_studio_full_noshadow.svg" alt="Ship Studio" className="app-logo" />
          <div className="spinner" />
        </div>
        <BugReportButton />
      </>
    );
  }

  if (view === 'onboarding') {
    const handleOnboardingComplete = async () => {
      // Persist that setup is complete so future launches are fast
      await markSetupComplete();
      // Force full check to update all CLI states
      void checkSetup(true);
    };

    return (
      <>
        <div className="app">
          <UpdateBanner />
          <OnboardingScreen onComplete={() => void handleOnboardingComplete()} />
        </div>
        <BugReportButton />
      </>
    );
  }

  if (view === 'projects') {
    return (
      <>
        <div className="app">
          <UpdateBanner />
          <div className="dashboard-with-changelog">
            <ProjectList
              onSelectProject={(project) => void handleSelectProject(project)}
              onCreateProject={handleCreateProject}
              onImportProject={handleImportProject}
              isGitHubAuthenticated={integrations.github.cliStatus.authenticated}
              onGitHubConnectForImport={() => void handleGitHubConnectFromOverlay()}
              onGitHubConnect={handleGitHubConnectFromOverlay}
              onVercelConnect={handleVercelConnectFromOverlay}
              githubUsername={integrations.github.username}
              isAuthCheckDone={isInitialCheckDone}
              onLoadingChange={setProjectsLoading}
            />
            {!projectsLoading && <Changelog />}
          </div>
          {showCreateModal && (
            <CreateProject
              onComplete={handleProjectCreated}
              onCancel={() => setShowCreateModal(false)}
            />
          )}
          {importView === 'picker' && (
            <ImportTypePicker
              onSelectGitHub={() => setImportView('github')}
              onSelectLocalFolder={() => void handleImportLocalFolder()}
              onClose={() => setImportView('none')}
            />
          )}
          {importView === 'github' && (
            <ImportProject
              onComplete={handleProjectImported}
              onCancel={() => setImportView('none')}
            />
          )}

          {/* Auth Terminal Modal (for GitHub connect from projects view) */}
          {authTerminalConfig && (
            <div className="onboarding-terminal-overlay">
              <div className="onboarding-terminal-modal">
                <div className="onboarding-terminal-header">
                  <span className="onboarding-terminal-title">
                    {authTerminalConfig.service === 'github' ? 'GitHub Account' : 'Vercel Account'}
                  </span>
                  <button
                    className="onboarding-terminal-cancel"
                    onClick={() => closeAuthTerminal()}
                  >
                    Cancel
                  </button>
                </div>
                <OnboardingTerminal
                  command={authTerminalConfig.command}
                  args={authTerminalConfig.args}
                  onExit={(exitCode) => void handleAuthTerminalExit(exitCode, currentProject?.path)}
                />
              </div>
            </div>
          )}
        </div>
        <BugReportButton />
      </>
    );
  }

  if (view === 'project-loading') {
    return (
      <>
        <div className="app loading">
          <div className="spinner" />
          <p>Opening {currentProject?.name}...</p>
        </div>
        <BugReportButton />
      </>
    );
  }

  // Workspace view (responsive - adapts to narrow widths via CSS)
  return (
    <>
      <div className="app workspace">
        <UpdateBanner />
        <header className="workspace-header">
          <button className="back-button" onClick={() => void handleBackToProjects()}>
            ← Projects
          </button>
          <h1>{currentProject?.name}</h1>
          <button
            className="project-path"
            onClick={() =>
              currentProject?.path && void invoke('open_in_finder', { path: currentProject.path })
            }
            title="Open in Finder"
          >
            {currentProject?.path}
          </button>

          <div className="workspace-header-actions">
            <button
              className={`education-button ${isEducationMode ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setIsEducationMode(!isEducationMode);
              }}
              title="Education Mode"
              data-education-id="education-button"
            >
              <GraduationCapIcon size={14} />
            </button>
            <button
              className="assets-button"
              onClick={() => setShowAssetsPanel(true)}
              title="Assets"
              data-education-id="assets-button"
            >
              <ImageIcon size={14} />
            </button>
            <div
              className="ide-dropdown-container"
              onMouseEnter={() => setShowIdeDropdown(true)}
              onMouseLeave={() => setShowIdeDropdown(false)}
              data-education-id="ide-button"
            >
              <button className="ide-button" title="Open in IDE">
                <CodeIcon size={14} />
              </button>
              {showIdeDropdown && (
                <div className="ide-dropdown">
                  <div className="ide-dropdown-inner">
                    {ideAvailability.vscode && (
                      <button
                        onClick={() => void openInIde('vscode')}
                        disabled={openingIde !== null}
                      >
                        <VSCodeIcon size={14} />
                        {openingIde === 'vscode' ? 'Opening...' : 'VS Code'}
                      </button>
                    )}
                    {ideAvailability.cursor && (
                      <button
                        onClick={() => void openInIde('cursor')}
                        disabled={openingIde !== null}
                      >
                        <CursorIcon size={14} />
                        {openingIde === 'cursor' ? 'Opening...' : 'Cursor'}
                      </button>
                    )}
                    {!ideAvailability.vscode && !ideAvailability.cursor && (
                      <div className="ide-dropdown-empty">No IDEs found</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              className="env-button"
              onClick={() => setShowEnvEditor(true)}
              title="Environment Variables"
              data-education-id="env-button"
            >
              <DollarIcon size={14} />
            </button>
            <button
              className="backups-button"
              onClick={() => setShowBackupsModal(true)}
              title="Backups"
              data-education-id="backups-button"
            >
              <HistoryIcon size={14} />
            </button>
            <span data-education-id="github-button">
              <GitHubButton
                githubState={integrations.github}
                vercelState={integrations.vercel}
                projectStatus={integrations.projectGithub}
                projectPath={currentProject?.path || ''}
                projectName={currentProject?.name || ''}
                onStatusChange={handleGitHubStatusChange}
                onGitHubConnect={handleGitHubConnectFromOverlay}
                onModalClose={focusActiveTerminal}
                onToast={showToast}
                onVercelAutoConnectStart={() => setIsVercelAutoConnecting(true)}
                onVercelAutoConnectEnd={() => setIsVercelAutoConnecting(false)}
              />
            </span>
            {integrations.projectGithub?.status === 'connected' &&
              integrations.projectGithub?.github_repo && (
                <span data-education-id="vercel-button">
                  <VercelButton
                    vercelState={integrations.vercel}
                    projectVercelStatus={integrations.projectVercel}
                    projectGithubStatus={integrations.projectGithub}
                    projectPath={currentProject?.path || ''}
                    projectName={currentProject?.name || ''}
                    onStatusChange={(deployedUrl) => void handleVercelStatusChange(deployedUrl)}
                    onVercelConnect={() => void refreshVercelStatus()}
                    onModalClose={focusActiveTerminal}
                    onToast={showToast}
                    isAutoConnecting={isVercelAutoConnecting}
                    currentBranch={currentBranch || 'main'}
                  />
                </span>
              )}
            <PublishBranchDropdown
              currentBranch={currentBranch || 'main'}
              projectGithubStatus={integrations.projectGithub}
              projectVercelStatus={integrations.projectVercel}
              projectPath={currentProject?.path || ''}
              hasChangesToSync={hasUncommittedChanges}
              onStatusChange={() => {
                void handleGitHubStatusChange();
                if (currentProject) void fetchBranchInfo(currentProject.path);
              }}
              onModalClose={focusActiveTerminal}
              onToast={showToast}
              isPublishing={isPublishing}
              setIsPublishing={setIsPublishing}
              onPublishError={handlePublishError}
              forceOpen={forcePublishOpen}
              onForceOpenHandled={() => setForcePublishOpen(false)}
            />
          </div>
        </header>

        {(currentBranch === 'main' || currentBranch === 'master') && currentProject && (
          <MainBranchBanner
            projectPath={currentProject.path}
            onCreateBranch={() => setWorkspaceTab('branches')}
          />
        )}

        <div className="workspace-content">
          <SplitPane
            defaultSplit={28}
            minLeft={20}
            minRight={35}
            rightCollapsed={isPreviewHidden}
            left={
              <div className="terminal-pane">
                <CodeHealthPanel
                  ref={healthPanelRef}
                  projectPath={currentProject?.path || ''}
                  onToast={showToast}
                  onAskClaude={sendToClaude}
                  onHealthOutput={handleHealthOutput}
                  toolbarLeft={
                    <button
                      className="show-preview-btn"
                      onClick={() => void handleRestartDevServer()}
                      disabled={isRestartingDevServer || !devServerRef.current}
                      title="Restart dev server"
                      data-education-id="restart-server"
                    >
                      {isRestartingDevServer ? (
                        <div className="capture-spinner" />
                      ) : (
                        <ResetIcon size={14} />
                      )}
                      <span>Restart Server</span>
                    </button>
                  }
                  toolbarRight={
                    isPreviewHidden ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button
                          className="show-preview-btn icon-only"
                          onClick={() => void handleEnterCompactMode()}
                          title="Compact Mode"
                          data-education-id="compact-button"
                        >
                          <CompactIcon size={12} />
                        </button>
                        <span data-education-id="browser-button">
                          <BrowserDropdown
                            url={`http://localhost:${devServerPort}`}
                            buttonClassName="show-preview-btn icon-only"
                            iconOnly
                          />
                        </span>
                        <button
                          className="show-preview-btn icon-only"
                          onClick={() => setIsPreviewHidden(false)}
                          title="Show Preview"
                        >
                          <PanelRightIcon size={12} />
                        </button>
                      </div>
                    ) : undefined
                  }
                />
                {/* Terminal view - hidden in compact mode when viewing branches/PRs */}
                <div
                  className={`compact-terminal-view ${compactView !== 'terminal' ? 'compact-hidden' : ''}`}
                >
                  <div className="terminal-tabs-bar">
                    <div className="terminal-tabs" data-education-id="terminal-tabs">
                      {terminalTabs.map((tabId, index) => (
                        <button
                          key={tabId}
                          className={`workspace-tab ${!showDevServerLogs && activeTerminalTab === tabId ? 'active' : ''}`}
                          onClick={() => {
                            setShowDevServerLogs(false);
                            setShowHealthLogs(false);
                            setActiveTerminalTab(tabId);
                          }}
                        >
                          <span className="terminal-tab-number">{index + 1}</span>
                          {terminalTabs.length > 1 && (
                            <span
                              className="terminal-tab-close"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeTerminalTab(tabId);
                              }}
                            >
                              <CloseIcon size={10} />
                            </span>
                          )}
                        </button>
                      ))}
                      {terminalTabs.length < maxTerminalTabs && (
                        <button className="terminal-tab-add" onClick={addTerminalTab}>
                          <PlusIcon size={12} />
                        </button>
                      )}
                    </div>
                    <div className="terminal-logs-tabs">
                      <button
                        className={`workspace-tab icon-only ${showDevServerLogs && !showHealthLogs ? 'active' : ''}`}
                        onClick={() => {
                          setShowDevServerLogs(true);
                          setShowHealthLogs(false);
                        }}
                        title="View dev server logs"
                        data-education-id="server-logs"
                      >
                        <TerminalIcon size={12} />
                      </button>
                      <button
                        className={`workspace-tab icon-only ${showHealthLogs ? 'active' : ''}`}
                        onClick={() => {
                          setShowDevServerLogs(true);
                          setShowHealthLogs(true);
                        }}
                        title="View health check logs"
                        data-education-id="health-logs"
                      >
                        <ActivityIcon size={12} />
                      </button>
                      <button
                        className="workspace-tab icon-only"
                        onClick={() => setShowNotificationSettings(true)}
                        title="Notification sounds"
                        data-education-id="notification-settings"
                      >
                        <BellIcon size={12} />
                      </button>
                      <button
                        className="workspace-tab icon-only"
                        onClick={() => setShowSkillsModal(true)}
                        title="Manage Skills"
                        data-education-id="skills-manager"
                      >
                        <ZapIcon size={12} />
                      </button>
                      <button
                        className="workspace-tab icon-only"
                        onClick={() => setShowHelpModal(true)}
                        title="Help & Commands"
                        data-education-id="help-commands"
                      >
                        <HelpIcon size={12} />
                      </button>
                    </div>

                    {/* Compact mode controls - visible only at narrow widths via CSS */}
                    <div className="compact-mode-controls">
                      <button
                        className={`compact-control-btn ${isPinned ? 'active' : ''}`}
                        onClick={() => void handlePinToggle()}
                        title={isPinned ? 'Unpin from top' : 'Pin to top'}
                      >
                        <PinIcon size={12} />
                      </button>
                      <button
                        className="compact-control-btn"
                        onClick={() => void handleExpandToFull()}
                        title="Expand to full mode"
                      >
                        <ExpandIcon size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="terminal-content" data-education-id="claude-terminal">
                    {terminalTabs.map((tabId) => (
                      <div
                        key={`session-${terminalSessionId}-tab-${tabId}`}
                        className="terminal-tab-content"
                        style={{
                          display:
                            !showDevServerLogs && activeTerminalTab === tabId ? 'block' : 'none',
                        }}
                      >
                        <Terminal
                          ref={(ref) => {
                            if (ref) {
                              terminalRefsMap.current.set(tabId, ref);
                            }
                          }}
                          projectPath={currentProject?.path || ''}
                          onExit={handleTerminalExit}
                          autoAcceptMode={autoAcceptMode}
                          onStatusChange={handleClaudeStatusChange}
                        />
                      </div>
                    ))}
                    {showDevServerLogs && !showHealthLogs && (
                      <div className="terminal-tab-content" style={{ display: 'block' }}>
                        <DevServerLogs
                          output={devServerOutputRef.current}
                          outputVersion={devServerOutputVersion}
                        />
                      </div>
                    )}
                    {showHealthLogs && (
                      <div className="terminal-tab-content" style={{ display: 'block' }}>
                        <DevServerLogs
                          output={healthOutputRef.current}
                          outputVersion={healthOutputVersion}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Compact branches/PRs view - shown in compact mode when viewing branches or PRs */}
                <div
                  className={`compact-branches-view ${compactView === 'terminal' ? 'compact-hidden' : ''}`}
                >
                  {/* Back button header */}
                  <div className="compact-branches-header">
                    <button className="compact-back-btn" onClick={() => setCompactView('terminal')}>
                      <ArrowLeftIcon size={12} />
                      <span>Terminal</span>
                    </button>
                    <span className="compact-branches-title">
                      {compactView === 'branches' ? 'Branches' : 'Pull Requests'}
                    </span>
                    {/* Compact mode controls */}
                    <div className="compact-mode-controls" style={{ marginLeft: 'auto' }}>
                      <button
                        className={`compact-control-btn ${isPinned ? 'active' : ''}`}
                        onClick={() => void handlePinToggle()}
                        title={isPinned ? 'Unpin from top' : 'Pin to top'}
                      >
                        <PinIcon size={12} />
                      </button>
                      <button
                        className="compact-control-btn"
                        onClick={() => void handleExpandToFull()}
                        title="Expand to full mode"
                      >
                        <ExpandIcon size={12} />
                      </button>
                    </div>
                  </div>
                  {/* Content */}
                  <div className="compact-branches-content">
                    {compactView === 'branches' &&
                      currentProject &&
                      integrations.github.cliStatus.authenticated &&
                      integrations.projectGithub?.status === 'connected' && (
                        <BranchesTab
                          branches={branches}
                          currentBranch={currentBranch || ''}
                          projectPath={currentProject.path}
                          githubUsername={integrations.github.username}
                          openPRs={openPRs}
                          onBranchSwitch={(branchName) => {
                            void handleBranchSwitch(branchName);
                            setCompactView('terminal'); // Return to terminal after switching
                          }}
                          onSubmitForReview={(branchName) => setShowSubmitReview(branchName)}
                          onRefresh={() => void fetchBranchInfo(currentProject.path)}
                          onToast={showToast}
                        />
                      )}
                    {compactView === 'prs' &&
                      currentProject &&
                      integrations.github.cliStatus.authenticated &&
                      integrations.projectGithub?.status === 'connected' && (
                        <PullRequestsTab
                          projectPath={currentProject.path}
                          githubUsername={integrations.github.username}
                          onRefresh={() => void fetchBranchInfo(currentProject.path)}
                          onToast={showToast}
                          onBranchSwitch={(branchName) => {
                            void handleBranchSwitch(branchName);
                            setCompactView('terminal'); // Return to terminal after switching
                          }}
                          onNavigateToBranches={() => setCompactView('branches')}
                          onResolveConflicts={(headBranch, baseBranch) =>
                            void handleResolveConflicts(headBranch, baseBranch)
                          }
                        />
                      )}
                  </div>
                </div>
              </div>
            }
            right={
              <div className="preview-pane">
                {/* Preview/Branches/PRs Tabs - always show all tabs */}
                <div className="preview-tabs-bar">
                  {/* Branch Indicator - only show when GitHub is connected and we have branch info */}
                  {integrations.projectGithub?.status === 'connected' && currentBranch && (
                    <BranchIndicator
                      currentBranch={currentBranch}
                      hasUncommittedChanges={hasUncommittedChanges}
                      changedFiles={changedFiles}
                      projectPath={currentProject?.path || ''}
                      isOnBranchesTab={workspaceTab === 'branches' || workspaceTab === 'prs'}
                      onClick={() =>
                        setWorkspaceTab(
                          workspaceTab === 'branches' || workspaceTab === 'prs'
                            ? 'preview'
                            : 'branches'
                        )
                      }
                      onDiscard={() => {
                        if (currentProject) {
                          void checkGitStatus(currentProject.path);
                        }
                      }}
                      onToast={showToast}
                      onSave={() => setForcePublishOpen(true)}
                    />
                  )}
                  <div style={{ flex: 1 }} />
                  {integrations.projectGithub?.status === 'connected' && (
                    <div className="workspace-tabs">
                      <button
                        className={`workspace-tab ${workspaceTab === 'preview' ? 'active' : ''}`}
                        onClick={() => setWorkspaceTab('preview')}
                      >
                        <EyeIcon size={14} />
                        <span>Preview</span>
                      </button>
                      <button
                        className={`workspace-tab ${workspaceTab === 'branches' ? 'active' : ''}`}
                        onClick={() => setWorkspaceTab('branches')}
                        data-education-id="branches-tab"
                      >
                        <BranchIcon size={14} />
                        <span>Branches</span>
                      </button>
                      <button
                        className={`workspace-tab ${workspaceTab === 'prs' ? 'active' : ''}`}
                        onClick={() => setWorkspaceTab('prs')}
                        data-education-id="prs-tab"
                      >
                        <PullRequestIcon size={14} />
                        <span>PRs</span>
                      </button>
                    </div>
                  )}
                  <div className="preview-tabs-divider" />
                  <div className="preview-actions">
                    <button
                      className="preview-action-btn-icon"
                      onClick={() => void handleEnterCompactMode()}
                      title="Compact Mode"
                      data-education-id="compact-button"
                    >
                      <CompactIcon size={12} />
                    </button>
                    <span data-education-id="browser-button">
                      <BrowserDropdown
                        url={`http://localhost:${devServerPort}`}
                        buttonClassName="preview-action-btn-icon"
                        iconOnly
                      />
                    </span>
                    <button
                      className="preview-action-btn-icon"
                      onClick={() => setIsPreviewHidden(true)}
                      title="Hide Preview"
                    >
                      <PanelRightIcon size={12} />
                    </button>
                  </div>
                </div>

                {/* Tab content */}
                {workspaceTab === 'preview' && (
                  <div style={{ flex: 1, display: 'flex' }}>
                    <Preview
                      key={`${currentProject?.path || 'none'}-${devServerPort}`}
                      ref={previewRef}
                      port={devServerPort}
                      projectPath={currentProject?.path || ''}
                      onServerReady={handlePreviewReady}
                      onPageChange={setCurrentPreviewPage}
                      isCropMode={isCropMode}
                      onCropStart={handleCropStart}
                      onCropComplete={handleCropComplete}
                      onCropCancel={handleCropCancel}
                      isBranchSwitching={isBranchSwitching}
                      isDevServerRestarting={isRestartingDevServer}
                      onSendToClaude={sendToClaude}
                      onToast={showToast}
                      toolbarExtra={
                        <div className="agent-toolbar">
                          <button
                            className="agent-capture-btn"
                            onClick={() => void handleCaptureForClaude()}
                            disabled={isCapturing || isCropMode || isFullPageCapturing}
                            title="Screenshot preview for Claude"
                            data-education-id="screenshot-button"
                          >
                            {isCapturing ? (
                              <div className="capture-spinner" />
                            ) : (
                              <CameraIcon size={14} />
                            )}
                          </button>
                          <button
                            className={`agent-capture-btn ${isCropMode ? 'active' : ''}`}
                            onClick={() => setIsCropMode(!isCropMode)}
                            disabled={isCapturing || isCropCapturing || isFullPageCapturing}
                            title="Crop screenshot for Claude"
                            data-education-id="crop-button"
                          >
                            {isCropCapturing ? (
                              <div className="capture-spinner" />
                            ) : (
                              <CropIcon size={14} />
                            )}
                          </button>
                          <button
                            className="agent-capture-btn"
                            onClick={() => void handleCaptureFullPage()}
                            disabled={
                              isCapturing || isCropCapturing || isFullPageCapturing || isCropMode
                            }
                            title="Full page screenshot for Claude"
                            data-education-id="fullpage-button"
                          >
                            {isFullPageCapturing ? (
                              <div className="capture-spinner" />
                            ) : (
                              <FullPageIcon size={14} />
                            )}
                          </button>
                        </div>
                      }
                    />
                  </div>
                )}
                {workspaceTab === 'branches' &&
                  currentProject &&
                  (integrations.github.cliStatus.authenticated &&
                  integrations.projectGithub?.status === 'connected' ? (
                    <BranchesTab
                      branches={branches}
                      currentBranch={currentBranch || ''}
                      projectPath={currentProject.path}
                      githubUsername={integrations.github.username}
                      openPRs={openPRs}
                      onBranchSwitch={(branchName) => void handleBranchSwitch(branchName)}
                      onSubmitForReview={(branchName) => setShowSubmitReview(branchName)}
                      onRefresh={() => void fetchBranchInfo(currentProject.path)}
                      onToast={showToast}
                    />
                  ) : (
                    <div style={{ position: 'relative', flex: 1 }}>
                      <ConnectOverlay
                        service="github"
                        title="Connect GitHub to manage branches"
                        description="Create branches, switch between versions, and collaborate with your team."
                        onConnect={() => void handleGitHubConnectFromOverlay()}
                      />
                    </div>
                  ))}
                {workspaceTab === 'prs' &&
                  currentProject &&
                  (integrations.github.cliStatus.authenticated &&
                  integrations.projectGithub?.status === 'connected' ? (
                    <PullRequestsTab
                      projectPath={currentProject.path}
                      githubUsername={integrations.github.username}
                      onRefresh={() => void fetchBranchInfo(currentProject.path)}
                      onToast={showToast}
                      onBranchSwitch={(branchName) => void handleBranchSwitch(branchName)}
                      onNavigateToBranches={() => setWorkspaceTab('branches')}
                      onResolveConflicts={(headBranch, baseBranch) =>
                        void handleResolveConflicts(headBranch, baseBranch)
                      }
                    />
                  ) : (
                    <div style={{ position: 'relative', flex: 1 }}>
                      <ConnectOverlay
                        service="github"
                        title="Connect GitHub to view pull requests"
                        description="Submit code for review, merge changes, and track your team's work."
                        onConnect={() => void handleGitHubConnectFromOverlay()}
                      />
                    </div>
                  ))}
              </div>
            }
          />
        </div>

        {/* Compact footer - visible only at narrow window widths via CSS */}
        <div className="compact-footer-container">
          {/* Compact publish dropdown - uses controlled mode (forceOpen synced with state)
              The button is hidden via CSS; only the dropdown menu appears */}
          <div className="compact-publish-dropdown">
            <PublishBranchDropdown
              currentBranch={currentBranch || 'main'}
              projectGithubStatus={integrations.projectGithub}
              projectVercelStatus={integrations.projectVercel}
              projectPath={currentProject?.path || ''}
              hasChangesToSync={hasUncommittedChanges}
              onStatusChange={() => {
                void handleGitHubStatusChange();
                if (currentProject) void fetchBranchInfo(currentProject.path);
              }}
              onModalClose={() => {
                setIsCompactPublishOpen(false);
                focusActiveTerminal();
              }}
              onToast={showToast}
              isPublishing={isPublishing}
              setIsPublishing={setIsPublishing}
              onPublishError={handlePublishError}
              forceOpen={isCompactPublishOpen}
              onForceOpenHandled={() => {}}
              excludeClickOutsideSelector=".compact-publish-btn"
            />
          </div>
          <CompactActionsRow
            serverHealth={
              devServerRef.current ? 'healthy' : isRestartingDevServer ? 'starting' : 'unhealthy'
            }
            currentBranch={currentBranch}
            hasUncommittedChanges={hasUncommittedChanges}
            prStatus={openPRs.find((pr) => pr.headRef === currentBranch) ? 'open' : 'none'}
            isGitHubConnected={integrations.projectGithub?.status === 'connected'}
            isSynced={!hasUncommittedChanges}
            onRestartServer={() => void handleRestartDevServer()}
            onOpenAssets={() => setShowAssetsPanel(true)}
            onOpenEnvEditor={() => setShowEnvEditor(true)}
            onCreateRepo={() => {
              // Button only shows when GitHub not connected, so prompt GitHub connection
              void handleGitHubConnectFromOverlay();
            }}
            onSwitchBranch={() => {
              // Toggle between terminal and branches view in compact mode
              setCompactView(compactView === 'branches' ? 'terminal' : 'branches');
            }}
            onCreatePR={() => {
              // Toggle between terminal and PRs view in compact mode
              setCompactView(compactView === 'prs' ? 'terminal' : 'prs');
            }}
            onPublish={() => setIsCompactPublishOpen((prev) => !prev)}
          />
        </div>

        <EnvEditor
          projectPath={currentProject?.path || ''}
          isOpen={showEnvEditor}
          onClose={() => {
            setShowEnvEditor(false);
            focusActiveTerminal();
          }}
          onToast={showToast}
        />

        <BackupsModal
          projectPath={currentProject?.path || ''}
          isOpen={showBackupsModal}
          onClose={() => {
            setShowBackupsModal(false);
            focusActiveTerminal();
          }}
          onRestore={() => {
            // Refresh branches and status after restore creates a new branch
            if (currentProject) void fetchBranchInfo(currentProject.path);
            void handleGitHubStatusChange();
          }}
          onCreatePR={(branchName) => {
            setShowSubmitReview(branchName);
          }}
        />

        <AssetsPanel
          projectPath={currentProject?.path || ''}
          isOpen={showAssetsPanel}
          onClose={() => {
            setShowAssetsPanel(false);
            focusActiveTerminal();
          }}
          onToast={showToast}
        />

        {/* Education Mode Overlay */}
        {isEducationMode && <EducationOverlay onClose={() => setIsEducationMode(false)} />}

        {/* Toast notifications */}
        {toasts.length > 0 && (
          <div className="toast-container">
            {toasts.map((toast) => (
              <div key={toast.id} className={`toast toast-${toast.type}`}>
                <span className="toast-icon">
                  {toast.type === 'success' ? <SuccessIcon size={16} /> : <InfoIcon size={16} />}
                </span>
                <span className="toast-message">{toast.message}</span>
                <button className="toast-close" onClick={() => dismissToast(toast.id)}>
                  <CloseIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Screenshot Preview Toast */}
        {screenshotPreviewPath && !showScreenshotModal && (
          <ScreenshotToast
            filePath={screenshotPreviewPath}
            onDismiss={() => setScreenshotPreviewPath(null)}
            onViewFull={() => setShowScreenshotModal(true)}
          />
        )}

        {/* Screenshot Preview Modal */}
        {showScreenshotModal && screenshotPreviewPath && (
          <ScreenshotPreviewModal
            filePath={screenshotPreviewPath}
            onClose={() => {
              setShowScreenshotModal(false);
              setScreenshotPreviewPath(null);
            }}
          />
        )}

        {/* Notification Settings Modal */}
        {showNotificationSettings && (
          <NotificationSettingsModal
            settings={notificationSettings}
            onSave={handleSaveNotificationSettings}
            onClose={() => setShowNotificationSettings(false)}
          />
        )}

        {/* Help Modal */}
        <HelpModal
          isOpen={showHelpModal}
          onClose={() => setShowHelpModal(false)}
          projectPath={currentProject?.path}
        />

        {/* Skills Modal */}
        <SkillsModal
          isOpen={showSkillsModal}
          onClose={() => setShowSkillsModal(false)}
          projectPath={currentProject?.path}
        />

        {/* Submit for Review Modal */}
        {showSubmitReview && (
          <SubmitReviewModal
            projectPath={currentProject?.path || ''}
            branchName={showSubmitReview}
            baseBranches={branches
              .filter((b) => b.isDefault || b.name === 'staging')
              .map((b) => b.name)}
            claudeAvailable={integrations.claude.cliStatus.installed}
            onSuccess={() => {
              showToast('Pull request created', 'success');
              if (currentProject) void fetchBranchInfo(currentProject.path);
            }}
            onClose={() => {
              setShowSubmitReview(null);
              focusActiveTerminal();
            }}
            onToast={showToast}
          />
        )}

        {/* Git Error Handler */}
        {gitError && (
          <GitErrorHandler
            errorType={gitError.errorType}
            errorMessage={gitError.message}
            branchName={gitError.branchName}
            onClose={() => setGitError(null)}
            onSendToClaude={sendToClaude}
            onToast={showToast}
            onResolveConflicts={() => void handleResolveConflicts()}
          />
        )}

        {/* Conflict Resolution Modal */}
        {showConflictResolution && currentProject && (
          <ConflictResolutionModal
            projectPath={currentProject.path}
            onClose={() => {
              setShowConflictResolution(false);
              focusActiveTerminal();
            }}
            onResolved={handleConflictsResolved}
            onToast={showToast}
          />
        )}

        {/* Auth Terminal Modal (for GitHub/Vercel connect from workspace) */}
        {authTerminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">
                  {authTerminalConfig.service === 'github' ? 'GitHub Account' : 'Vercel Account'}
                </span>
                <button className="onboarding-terminal-cancel" onClick={() => closeAuthTerminal()}>
                  Cancel
                </button>
              </div>
              <OnboardingTerminal
                command={authTerminalConfig.command}
                args={authTerminalConfig.args}
                onExit={(exitCode) => void handleAuthTerminalExit(exitCode, currentProject?.path)}
              />
            </div>
          </div>
        )}
      </div>
      <BugReportButton />
    </>
  );
}

export default App;
