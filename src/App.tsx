import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal, TerminalHandle } from "./components/Terminal";
import { Preview } from "./components/Preview";
import { ProjectList } from "./components/ProjectList";
import { CreateProject } from "./components/CreateProject";
import { SetupScreen } from "./components/SetupScreen";
import { SplitPane } from "./components/SplitPane";
import { GitHubButton } from "./components/GitHubButton";
import { VercelButton } from "./components/VercelButton";
import { checkPrerequisites, startDevServer, Prerequisite, Project, DevServerHandle } from "./lib/project";
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
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type AppView = "loading" | "setup" | "projects" | "create" | "workspace";

export interface GitHubState {
  cliStatus: GitHubCliStatus;
  username: string | null;
}

export interface VercelState {
  cliStatus: VercelCliStatus;
  username: string | null;
}

export interface ClaudeState {
  cliStatus: ClaudeCliStatus;
}

function App() {
  const [view, setView] = useState<AppView>("loading");
  const [prerequisites, setPrerequisites] = useState<Prerequisite[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const devServerRef = useRef<DevServerHandle | null>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const screenshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // GitHub state
  const [githubState, setGithubState] = useState<GitHubState>({
    cliStatus: { installed: false, authenticated: false },
    username: null,
  });
  const [projectGithubStatus, setProjectGithubStatus] = useState<ProjectGitHubStatus | null>(null);

  // Vercel state
  const [vercelState, setVercelState] = useState<VercelState>({
    cliStatus: { installed: false, authenticated: false },
    username: null,
  });
  const [projectVercelStatus, setProjectVercelStatus] = useState<ProjectVercelStatus | null>(null);

  // Claude state
  const [claudeState, setClaudeState] = useState<ClaudeState>({
    cliStatus: { installed: false, version: null },
  });

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    checkSetup();
  }, []);

  const checkSetup = async () => {
    setView("loading");
    try {
      const prereqs = await checkPrerequisites();
      setPrerequisites(prereqs);

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
      setGithubState({ cliStatus: ghStatus, username: ghUsername });

      let vcUsername: string | null = null;
      if (vcStatus.authenticated) {
        try {
          vcUsername = await getVercelUsername();
        } catch {
          // Ignore - username is optional
        }
      }
      setVercelState({ cliStatus: vcStatus, username: vcUsername });

      // Set Claude state
      setClaudeState({ cliStatus: clStatus });

      const allAvailable = prereqs.every((p) => p.available);
      if (allAvailable) {
        setView("projects");
      } else {
        setView("setup");
      }
    } catch (error) {
      console.error("Failed to check prerequisites:", error);
      setView("setup");
    }
  };

  const refreshGitHubStatus = async () => {
    const ghStatus = await checkGitHubCliStatus();
    let username: string | null = null;
    if (ghStatus.authenticated) {
      try {
        username = await getGitHubUsername();
      } catch {
        // Ignore
      }
    }
    setGithubState({ cliStatus: ghStatus, username });
  };

  const refreshVercelStatus = async () => {
    const vcStatus = await checkVercelCliStatus();
    let username: string | null = null;
    if (vcStatus.authenticated) {
      try {
        username = await getVercelUsername();
      } catch {
        // Ignore
      }
    }
    setVercelState({ cliStatus: vcStatus, username });
  };

  const refreshClaudeStatus = async () => {
    const clStatus = await checkClaudeCliStatus();
    setClaudeState({ cliStatus: clStatus });
  };

  // Focus terminal (called after modals close)
  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Capture project screenshot in background
  const captureScreenshot = useCallback(async (projectPath: string) => {
    try {
      await invoke("capture_project_thumbnail", {
        projectPath,
        url: "http://localhost:3000",
      });
    } catch (error) {
      console.error("Failed to capture thumbnail:", error);
    }
  }, []);

  // Capture screenshot and send file path to terminal
  const captureAndSend = useCallback(async (e: React.MouseEvent) => {
    if (isCapturing || !currentProject) return;

    // Prevent the button from stealing focus
    e.preventDefault();

    setIsCapturing(true);

    try {
      // 1. Capture screenshot to file
      const filePath = await invoke<string>("capture_preview_to_file", {
        url: "http://localhost:3000",
        projectPath: currentProject.path,
      });

      // 2. Write file path directly to terminal
      terminalRef.current?.write(filePath);

      // 3. Focus terminal
      terminalRef.current?.focus();
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, currentProject]);

  const handleSelectProject = async (project: Project) => {
    setCurrentProject(project);

    // Check project's GitHub and Vercel status in parallel
    try {
      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(project.path).catch(() => null),
        getProjectVercelStatus(project.path).catch(() => null),
      ]);
      setProjectGithubStatus(ghStatus);
      setProjectVercelStatus(vcStatus);
    } catch {
      setProjectGithubStatus(null);
      setProjectVercelStatus(null);
    }

    // Start dev server in background
    try {
      devServerRef.current = await startDevServer(project.path);
    } catch (error) {
      console.error("Failed to start dev server:", error);
    }

    setView("workspace");

    // Capture initial screenshot after a delay (wait for dev server to be ready)
    setTimeout(() => {
      captureScreenshot(project.path);
    }, 5000);

    // Capture screenshots every 5 minutes
    screenshotIntervalRef.current = setInterval(() => {
      captureScreenshot(project.path);
    }, 5 * 60 * 1000);
  };

  const handleCreateProject = () => {
    setView("create");
  };

  const handleProjectCreated = async (projectPath: string) => {
    const projectName = projectPath.split("/").pop() || "project";
    handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleBackToProjects = async () => {
    // Clear screenshot interval
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }

    // Stop dev server if running
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }
    setCurrentProject(null);
    setProjectGithubStatus(null);
    setProjectVercelStatus(null);
    setView("projects");
  };

  const handleGitHubStatusChange = async () => {
    // Refresh project GitHub and Vercel status after push/publish
    if (currentProject) {
      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(currentProject.path).catch(() => null),
        getProjectVercelStatus(currentProject.path).catch(() => null),
      ]);
      setProjectGithubStatus(ghStatus);
      setProjectVercelStatus(vcStatus);
    }
  };

  const handleVercelStatusChange = async () => {
    // Refresh project Vercel status after linking
    if (currentProject) {
      const status = await getProjectVercelStatus(currentProject.path).catch(() => null);
      setProjectVercelStatus(status);
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

  if (view === "setup") {
    return (
      <div className="app">
        <SetupScreen prerequisites={prerequisites} onRetry={checkSetup} />
      </div>
    );
  }

  if (view === "projects") {
    return (
      <div className="app">
        <ProjectList
          onSelectProject={handleSelectProject}
          onCreateProject={handleCreateProject}
          githubState={githubState}
          vercelState={vercelState}
          claudeState={claudeState}
          onGitHubConnect={refreshGitHubStatus}
          onVercelConnect={refreshVercelStatus}
          onClaudeConnect={refreshClaudeStatus}
        />
      </div>
    );
  }

  if (view === "create") {
    return (
      <div className="app">
        <CreateProject
          onComplete={handleProjectCreated}
          onCancel={() => setView("projects")}
        />
      </div>
    );
  }

  // Workspace view
  return (
    <div className="app workspace">
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
          <GitHubButton
            githubState={githubState}
            vercelState={vercelState}
            projectStatus={projectGithubStatus}
            projectPath={currentProject?.path || ""}
            projectName={currentProject?.name || ""}
            onStatusChange={handleGitHubStatusChange}
            onGitHubConnect={refreshGitHubStatus}
            onModalClose={focusTerminal}
          />
          <VercelButton
            vercelState={vercelState}
            projectVercelStatus={projectVercelStatus}
            projectGithubStatus={projectGithubStatus}
            projectPath={currentProject?.path || ""}
            projectName={currentProject?.name || ""}
            onStatusChange={handleVercelStatusChange}
            onVercelConnect={refreshVercelStatus}
            onModalClose={focusTerminal}
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
                <span className="terminal-title">Claude Code</span>
                <button
                  className={`terminal-capture ${isCapturing ? "capturing" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={captureAndSend}
                  disabled={isCapturing}
                  title="Capture preview screenshot and send to Claude"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
              </div>
              <div className="terminal-content">
                <Terminal
                  ref={terminalRef}
                  projectPath={currentProject?.path || ""}
                  onExit={(code) => {
                    console.log("Terminal exited with code:", code);
                  }}
                />
              </div>
            </div>
          }
          right={
            <div className="preview-pane">
              <Preview port={3000} projectPath={currentProject?.path || ""} />
            </div>
          }
        />
      </div>
    </div>
  );
}

export default App;
