/**
 * Main application component and state management.
 *
 * This is the root component that orchestrates:
 * - Application views (loading, setup, projects, workspace)
 * - Integration state (GitHub, Vercel, Claude CLI status)
 * - Project management (opening, creating, dev server lifecycle)
 * - Terminal and preview panel coordination
 * - Periodic screenshot capture for thumbnails
 * - Toast notifications
 *
 * State is managed via React's useReducer for atomic integration updates
 * and useState for simpler local state.
 *
 * @module App
 */

import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { Terminal, TerminalHandle } from "./components/Terminal";
import { Preview, PreviewHandle } from "./components/Preview";
import { ProjectList } from "./components/ProjectList";
import { CreateProject } from "./components/CreateProject";
import { OnboardingScreen } from "./components/setup";
import { SplitPane } from "./components/SplitPane";
import { GitHubButton } from "./components/GitHubButton";
import { VercelButton } from "./components/VercelButton";
import { PublishDropdown } from "./components/PublishDropdown";
import { EnvEditor } from "./components/EnvEditor";
import {
  CodeIcon,
  ChatIcon,
  CameraIcon,
  CropIcon,
  SuccessIcon,
  InfoIcon,
  CloseIcon,
  VSCodeIcon,
  CursorIcon,
} from "./components/icons";
import { startDevServer, Project, DevServerHandle } from "./lib/project";
import {
  checkGitHubCliStatus,
  getGitHubUsername,
  getProjectGitHubStatus,
  GitHubCliStatus,
  ProjectGitHubStatus,
} from "./lib/github";
import {
  checkVercelCliStatus,
  getVercelUsername,
  getProjectVercelStatus,
  VercelCliStatus,
  ProjectVercelStatus,
} from "./lib/vercel";
import { checkClaudeCliStatus, ClaudeCliStatus } from "./lib/claude";
import { getFullSetupStatus } from "./lib/setup";
import { UpdateBanner } from "./components/UpdateBanner";
import { invoke } from "@tauri-apps/api/core";
import "./styles/index.css";

/** Interval between automatic screenshot captures (5 minutes) */
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** Delay after page load before capturing screenshot (2 seconds) */
const SCREENSHOT_DELAY_MS = 2000;
/** Default port for Next.js dev server */
const DEV_SERVER_PORT = 3000;

/** Current application view/screen */
type AppView = "loading" | "onboarding" | "projects" | "project-loading" | "workspace";

/** Global GitHub CLI and authentication state */
export interface GitHubState {
  /** CLI installation and auth status */
  cliStatus: GitHubCliStatus;
  /** Authenticated username or null */
  username: string | null;
}

/** Global Vercel CLI and authentication state */
export interface VercelState {
  /** CLI installation and auth status */
  cliStatus: VercelCliStatus;
  /** Authenticated username or null */
  username: string | null;
}

/** Global Claude CLI state */
export interface ClaudeState {
  /** CLI installation status and version */
  cliStatus: ClaudeCliStatus;
}

/**
 * Consolidated integration state for all external services.
 * Managed via useReducer for atomic updates to prevent race conditions.
 */
interface IntegrationState {
  /** GitHub CLI and auth state */
  github: GitHubState;
  /** Current project's GitHub repo status */
  projectGithub: ProjectGitHubStatus | null;
  /** Vercel CLI and auth state */
  vercel: VercelState;
  /** Current project's Vercel deployment status */
  projectVercel: ProjectVercelStatus | null;
  /** Claude CLI state */
  claude: ClaudeState;
}

type IntegrationAction =
  | { type: 'SET_GITHUB'; payload: GitHubState }
  | { type: 'SET_PROJECT_GITHUB'; payload: ProjectGitHubStatus | null }
  | { type: 'SET_VERCEL'; payload: VercelState }
  | { type: 'SET_PROJECT_VERCEL'; payload: ProjectVercelStatus | null }
  | { type: 'SET_CLAUDE'; payload: ClaudeState }
  | { type: 'CLEAR_PROJECT_STATUSES' }
  | { type: 'SET_ALL_CLI'; payload: { github: GitHubState; vercel: VercelState; claude: ClaudeState } }
  | { type: 'SET_PROJECT_STATUSES'; payload: { github: ProjectGitHubStatus | null; vercel: ProjectVercelStatus | null } };

const initialIntegrationState: IntegrationState = {
  github: { cliStatus: { installed: false, authenticated: false }, username: null },
  projectGithub: null,
  vercel: { cliStatus: { installed: false, authenticated: false }, username: null },
  projectVercel: null,
  claude: { cliStatus: { installed: false, version: null } },
};

function integrationReducer(state: IntegrationState, action: IntegrationAction): IntegrationState {
  switch (action.type) {
    case 'SET_GITHUB':
      return { ...state, github: action.payload };
    case 'SET_PROJECT_GITHUB':
      return { ...state, projectGithub: action.payload };
    case 'SET_VERCEL':
      return { ...state, vercel: action.payload };
    case 'SET_PROJECT_VERCEL':
      return { ...state, projectVercel: action.payload };
    case 'SET_CLAUDE':
      return { ...state, claude: action.payload };
    case 'CLEAR_PROJECT_STATUSES':
      return { ...state, projectGithub: null, projectVercel: null };
    case 'SET_ALL_CLI':
      return { ...state, github: action.payload.github, vercel: action.payload.vercel, claude: action.payload.claude };
    case 'SET_PROJECT_STATUSES':
      return { ...state, projectGithub: action.payload.github, projectVercel: action.payload.vercel };
    default:
      return state;
  }
}

function App() {
  const [view, setView] = useState<AppView>("loading");
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const devServerRef = useRef<DevServerHandle | null>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const screenshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);

  // Integration states consolidated via reducer for atomic updates
  const [integrations, dispatch] = useReducer(integrationReducer, initialIntegrationState);

  // Capture state for screenshot button
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const [isCropCapturing, setIsCropCapturing] = useState(false);

  // Env editor modal
  const [showEnvEditor, setShowEnvEditor] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // IDE dropdown
  const [showIdeDropdown, setShowIdeDropdown] = useState(false);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({ vscode: false, cursor: false });
  const [openingIde, setOpeningIde] = useState<string | null>(null);

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState("/");

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: "success" | "error" }>>([]);
  const toastIdRef = useRef(0);

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);

  // Vercel auto-connecting state (when linking after GitHub repo creation)
  const [isVercelAutoConnecting, setIsVercelAutoConnecting] = useState(false);

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = ++toastIdRef.current;
    setToasts(prev => {
      // Keep max 5 toasts, remove oldest if needed
      const updated = [...prev, { id, message, type }];
      return updated.slice(-5);
    });
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Check IDE availability on mount
  useEffect(() => {
    invoke<{ vscode: boolean; cursor: boolean }>("check_ide_availability")
      .then(setIdeAvailability)
      .catch(() => setIdeAvailability({ vscode: false, cursor: false }));
  }, []);

  // Open project in IDE
  const openInIde = async (ide: "vscode" | "cursor") => {
    if (!currentProject) return;
    setOpeningIde(ide);
    try {
      await invoke("open_in_ide", { projectPath: currentProject.path, ide });
      // Command completed (IDE process spawned), reset state
      // Dropdown closes naturally when user moves mouse away
      setOpeningIde(null);
    } catch (e) {
      console.error(`Failed to open in ${ide}:`, e);
      setOpeningIde(null);
    }
  };

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    checkSetup();
  }, []);

  const checkSetup = async () => {
    setView("loading");
    try {
      // Get full setup status (tools + auth)
      const setupStatus = await getFullSetupStatus();

      // Check GitHub, Vercel, and Claude status in parallel
      const [ghStatus, vcStatus, clStatus] = await Promise.all([
        checkGitHubCliStatus(),
        checkVercelCliStatus(),
        checkClaudeCliStatus(),
      ]);

      let ghUsername: string | null = null;
      if (ghStatus.authenticated) {
        try {
          ghUsername = await getGitHubUsername();
        } catch {
          // Ignore - username is optional
        }
      }

      let vcUsername: string | null = null;
      if (vcStatus.authenticated) {
        try {
          vcUsername = await getVercelUsername();
        } catch {
          // Ignore - username is optional
        }
      }

      // Set all CLI states atomically
      dispatch({
        type: 'SET_ALL_CLI',
        payload: {
          github: { cliStatus: ghStatus, username: ghUsername },
          vercel: { cliStatus: vcStatus, username: vcUsername },
          claude: { cliStatus: clStatus },
        },
      });

      // Use full setup status to determine if onboarding is needed
      if (setupStatus.allReady) {
        setView("projects");
      } else {
        setView("onboarding");
      }
    } catch (error) {
      console.error("Failed to check prerequisites:", error);
      setView("onboarding");
    }
  };

  // Generic refresh helper for authenticated integrations (GitHub, Vercel)
  const refreshAuthenticatedIntegration = async (
    checkStatus: () => Promise<GitHubCliStatus> | Promise<VercelCliStatus>,
    getUsername: () => Promise<string>,
    actionType: 'SET_GITHUB' | 'SET_VERCEL',
  ) => {
    const status = await checkStatus();
    let username: string | null = null;
    if (status.authenticated) {
      try {
        username = await getUsername();
      } catch {
        // Ignore - username is optional
      }
    }
    dispatch({ type: actionType, payload: { cliStatus: status, username } });
  };

  const refreshGitHubStatus = () =>
    refreshAuthenticatedIntegration(checkGitHubCliStatus, getGitHubUsername, 'SET_GITHUB');

  const refreshVercelStatus = () =>
    refreshAuthenticatedIntegration(checkVercelCliStatus, getVercelUsername, 'SET_VERCEL');

  const refreshClaudeStatus = async () => {
    const status = await checkClaudeCliStatus();
    dispatch({ type: 'SET_CLAUDE', payload: { cliStatus: status } });
  };

  // Focus terminal (called after modals close)
  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Handle capture for Claude - screenshot preview and paste path into terminal
  const handleCaptureForClaude = useCallback(async () => {
    if (isCapturing || !previewRef.current) return;

    setIsCapturing(true);
    try {
      const filePath = await previewRef.current.captureForClaude();
      if (filePath) {
        // Quote path if it contains spaces
        const quotedPath = filePath.includes(" ") ? `"${filePath}"` : filePath;
        terminalRef.current?.paste(quotedPath);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing]);

  // Handle crop mode start - show loading state
  const handleCropStart = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(true);
  }, []);

  // Handle crop mode completion - paste path into terminal
  const handleCropComplete = useCallback((filePath: string | null) => {
    setIsCropCapturing(false);
    if (filePath) {
      const quotedPath = filePath.includes(" ") ? `"${filePath}"` : filePath;
      terminalRef.current?.paste(quotedPath);
    }
  }, []);

  // Handle crop mode cancel
  const handleCropCancel = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(false);
  }, []);

  // Handle terminal exit (memoized to prevent re-spawning Claude on every render)
  const handleTerminalExit = useCallback((code: number | null) => {
    console.log("Terminal exited with code:", code);
  }, []);

  // Capture project screenshot in background
  const captureScreenshot = useCallback(async (projectPath: string) => {
    try {
      await invoke("capture_project_thumbnail", {
        projectPath,
        url: `http://localhost:${DEV_SERVER_PORT}`,
      });
    } catch (error) {
      console.error("Failed to capture thumbnail:", error);
    }
  }, []);

  // Handle preview server ready - capture initial screenshot
  const handlePreviewReady = useCallback(() => {
    if (currentProject) {
      setTimeout(() => {
        captureScreenshot(currentProject.path);
      }, SCREENSHOT_DELAY_MS);
    }
  }, [currentProject, captureScreenshot]);


  const handleSelectProject = async (project: Project) => {
    // Stop any existing dev server first
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }

    // Kill any process still listening on dev server port (handles orphaned processes)
    try {
      await invoke("kill_port", { port: DEV_SERVER_PORT });
    } catch {
      // Ignore errors - port may already be free
    }

    // Clear any existing screenshot interval
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }

    // Reset publishing and auto-connecting state when switching projects
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);

    setCurrentProject(project);
    setCurrentPreviewPage("/");
    currentProjectPathRef.current = project.path;
    setView("project-loading");

    // Mark project as opened (for sorting by last opened)
    invoke("mark_project_opened", { projectPath: project.path }).catch(() => {});

    // Ensure .marketingstack/ is gitignored (backwards compat for existing projects)
    invoke("ensure_gitignore_has_marketingstack", { projectPath: project.path }).catch(() => {});

    // Check project's GitHub and Vercel status in parallel
    try {
      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(project.path).catch(() => null),
        getProjectVercelStatus(project.path).catch(() => null),
      ]);
      dispatch({ type: 'SET_PROJECT_STATUSES', payload: { github: ghStatus, vercel: vcStatus } });
    } catch {
      dispatch({ type: 'CLEAR_PROJECT_STATUSES' });
    }

    // Start dev server in background
    try {
      devServerRef.current = await startDevServer(project.path);
    } catch (error) {
      console.error("Failed to start dev server:", error);
    }

    setView("workspace");

    // Capture screenshots periodically - check ref to avoid stale closure
    const projectPath = project.path;
    screenshotIntervalRef.current = setInterval(() => {
      // Only capture if this is still the current project
      if (currentProjectPathRef.current === projectPath) {
        captureScreenshot(projectPath);
      }
    }, SCREENSHOT_INTERVAL_MS);
  };

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleProjectCreated = async (projectPath: string) => {
    setShowCreateModal(false);
    const projectName = projectPath.split("/").pop() || "project";
    handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleBackToProjects = async () => {
    // Clear screenshot interval and project ref
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }
    currentProjectPathRef.current = null;

    // Reset publishing and auto-connecting state
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);

    // Stop dev server if running
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }
    setCurrentProject(null);
    dispatch({ type: 'CLEAR_PROJECT_STATUSES' });
    setView("projects");
  };

  const handleGitHubStatusChange = async (vercelDeployedUrl?: string) => {
    // Refresh project GitHub and Vercel status after push/publish
    if (currentProject) {
      // If we have a vercel deployed URL, optimistically set Vercel as connected
      // This avoids race conditions where the status check runs before Vercel's state propagates
      if (vercelDeployedUrl) {
        const ghStatus = await getProjectGitHubStatus(currentProject.path).catch(() => null);
        dispatch({
          type: 'SET_PROJECT_STATUSES',
          payload: {
            github: ghStatus,
            vercel: {
              status: "connected",
              project_name: currentProject.name,
              production_url: vercelDeployedUrl.replace(/^https?:\/\//, ''),
              staging_url: null,
              vercel_org: null,
            },
          },
        });
        return;
      }

      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(currentProject.path).catch(() => null),
        getProjectVercelStatus(currentProject.path).catch(() => null),
      ]);
      dispatch({ type: 'SET_PROJECT_STATUSES', payload: { github: ghStatus, vercel: vcStatus } });
    }
  };

  const handleVercelStatusChange = async (deployedUrl?: string) => {
    // If we have a deployed URL from a successful deployment, use it directly
    if (deployedUrl && currentProject) {
      dispatch({
        type: 'SET_PROJECT_VERCEL',
        payload: {
          status: "connected",
          project_name: currentProject.name,
          production_url: deployedUrl,
          staging_url: integrations.projectVercel?.staging_url ?? null,
          vercel_org: integrations.projectVercel?.vercel_org ?? null,
        },
      });
      return;
    }
    // Otherwise refresh project Vercel status
    if (currentProject) {
      const status = await getProjectVercelStatus(currentProject.path).catch(() => null);
      dispatch({ type: 'SET_PROJECT_VERCEL', payload: status });
    }
  };

  if (view === "loading") {
    return (
      <div className="app loading">
        <div className="spinner" />
        <p>Loading Marketingstack...</p>
      </div>
    );
  }

  if (view === "onboarding") {
    return (
      <div className="app">
        <OnboardingScreen onComplete={checkSetup} />
      </div>
    );
  }

  if (view === "projects") {
    return (
      <div className="app">
        <UpdateBanner />
        <ProjectList
          onSelectProject={handleSelectProject}
          onCreateProject={handleCreateProject}
          githubState={integrations.github}
          vercelState={integrations.vercel}
          claudeState={integrations.claude}
          onGitHubConnect={refreshGitHubStatus}
          onVercelConnect={refreshVercelStatus}
          onClaudeConnect={refreshClaudeStatus}
        />
        {showCreateModal && (
          <CreateProject
            onComplete={handleProjectCreated}
            onCancel={() => setShowCreateModal(false)}
          />
        )}
      </div>
    );
  }

  if (view === "project-loading") {
    return (
      <div className="app loading">
        <div className="spinner" />
        <p>Opening {currentProject?.name}...</p>
      </div>
    );
  }

  // Workspace view
  return (
    <div className="app workspace">
      <UpdateBanner />
      <header className="workspace-header">
        <button
          className="back-button"
          onClick={handleBackToProjects}
        >
          ← Projects
        </button>
        <h1>{currentProject?.name}</h1>
        <span className="project-path">{currentProject?.path}</span>

        <div className="workspace-header-actions">
          <div
            className="ide-dropdown-container"
            onMouseEnter={() => setShowIdeDropdown(true)}
            onMouseLeave={() => setShowIdeDropdown(false)}
          >
            <button className="ide-button" title="Open in IDE">
              <CodeIcon size={14} />
            </button>
            {showIdeDropdown && (
              <div className="ide-dropdown">
                <div className="ide-dropdown-inner">
                  {ideAvailability.vscode && (
                    <button onClick={() => openInIde("vscode")} disabled={openingIde !== null}>
                      <VSCodeIcon size={14} />
                      {openingIde === "vscode" ? "Opening..." : "VS Code"}
                    </button>
                  )}
                  {ideAvailability.cursor && (
                    <button onClick={() => openInIde("cursor")} disabled={openingIde !== null}>
                      <CursorIcon size={14} />
                      {openingIde === "cursor" ? "Opening..." : "Cursor"}
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
          >
            <span className="env-button-icon">$</span>
            .env
          </button>
          <GitHubButton
            githubState={integrations.github}
            vercelState={integrations.vercel}
            projectStatus={integrations.projectGithub}
            projectPath={currentProject?.path || ""}
            projectName={currentProject?.name || ""}
            onStatusChange={handleGitHubStatusChange}
            onGitHubConnect={refreshGitHubStatus}
            onModalClose={focusTerminal}
            onToast={showToast}
            onVercelAutoConnectStart={() => setIsVercelAutoConnecting(true)}
            onVercelAutoConnectEnd={() => setIsVercelAutoConnecting(false)}
          />
          <VercelButton
            vercelState={integrations.vercel}
            projectVercelStatus={integrations.projectVercel}
            projectGithubStatus={integrations.projectGithub}
            projectPath={currentProject?.path || ""}
            projectName={currentProject?.name || ""}
            onStatusChange={handleVercelStatusChange}
            onVercelConnect={refreshVercelStatus}
            onModalClose={focusTerminal}
            onToast={showToast}
            isAutoConnecting={isVercelAutoConnecting}
          />
          <PublishDropdown
            projectGithubStatus={integrations.projectGithub}
            projectVercelStatus={integrations.projectVercel}
            projectPath={currentProject?.path || ""}
            onStatusChange={handleGitHubStatusChange}
            onModalClose={focusTerminal}
            onToast={showToast}
            isPublishing={isPublishing}
            setIsPublishing={setIsPublishing}
          />
        </div>
      </header>

      <div className="workspace-content">
        <SplitPane
          defaultSplit={28}
          minLeft={20}
          minRight={35}
          left={
            <div className="terminal-pane">
              <div className="terminal-toolbar">
                <div className="agent-toolbar">
                  <div className="agent-label">
                    <ChatIcon size={14} />
                    <span>Agent</span>
                  </div>
                  <button
                    className="agent-capture-btn"
                    onClick={handleCaptureForClaude}
                    disabled={isCapturing || isCropMode}
                    title="Screenshot preview for Claude"
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
                    disabled={isCapturing || isCropCapturing}
                    title="Crop screenshot for Claude"
                  >
                    {isCropCapturing ? (
                      <div className="capture-spinner" />
                    ) : (
                      <CropIcon size={14} />
                    )}
                  </button>
                </div>
              </div>
              <div className="terminal-content">
                <Terminal
                  key={currentProject?.path || "none"}
                  ref={terminalRef}
                  projectPath={currentProject?.path || ""}
                  onExit={handleTerminalExit}
                />
              </div>
            </div>
          }
          right={
            <div className="preview-pane">
              <Preview
                key={currentProject?.path || "none"}
                ref={previewRef}
                port={DEV_SERVER_PORT}
                projectPath={currentProject?.path || ""}
                onServerReady={handlePreviewReady}
                onPageChange={setCurrentPreviewPage}
                isCropMode={isCropMode}
                onCropStart={handleCropStart}
                onCropComplete={handleCropComplete}
                onCropCancel={handleCropCancel}
              />
            </div>
          }
        />
      </div>

      <EnvEditor
        projectPath={currentProject?.path || ""}
        isOpen={showEnvEditor}
        onClose={() => {
          setShowEnvEditor(false);
          focusTerminal();
        }}
        onToast={showToast}
      />

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map(toast => (
            <div key={toast.id} className={`toast toast-${toast.type}`}>
              <span className="toast-icon">
                {toast.type === "success" ? (
                  <SuccessIcon size={16} />
                ) : (
                  <InfoIcon size={16} />
                )}
              </span>
              <span className="toast-message">{toast.message}</span>
              <button className="toast-close" onClick={() => dismissToast(toast.id)}>
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
