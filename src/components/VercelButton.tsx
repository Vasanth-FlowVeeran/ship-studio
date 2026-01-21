import { useState, useEffect, useRef } from "react";
import { VercelState } from "../App";
import {
  ProjectVercelStatus,
  installVercelCli,
  deployToVercel,
  checkVercelCliStatus,
} from "../lib/vercel";
import { ProjectGitHubStatus } from "../lib/github";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface VercelButtonProps {
  vercelState: VercelState;
  projectVercelStatus: ProjectVercelStatus | null;
  projectGithubStatus: ProjectGitHubStatus | null;
  projectPath: string;
  projectName: string;
  onStatusChange: (deployedUrl?: string) => void;
  onVercelConnect: () => void;
  onModalClose?: () => void;
  onToast?: (message: string, type?: "success" | "error") => void;
  isAutoConnecting?: boolean;
}

export function VercelButton({
  vercelState,
  projectVercelStatus,
  projectGithubStatus,
  projectPath,
  projectName,
  onStatusChange,
  onVercelConnect,
  onModalClose,
  onToast,
  isAutoConnecting,
}: VercelButtonProps) {
  const [isInstalling, setIsInstalling] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [loginOutput, setLoginOutput] = useState<string[]>([]);
  const [deployName, setDeployName] = useState(projectName);
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const ptyListenersRef = useRef<{ unlistenOutput?: () => void; unlistenExit?: () => void }>({});

  const { cliStatus } = vercelState;

  // Auto-scroll login output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [loginOutput]);

  // Cleanup PTY and listeners on unmount
  useEffect(() => {
    return () => {
      // Clean up any active listeners
      ptyListenersRef.current.unlistenOutput?.();
      ptyListenersRef.current.unlistenExit?.();
      ptyListenersRef.current = {};

      if (ptyIdRef.current !== null) {
        invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      }
    };
  }, []);

  // Don't show Vercel options until GitHub repo is created
  if (projectGithubStatus?.status !== "connected" || !projectGithubStatus?.github_repo) {
    return null;
  }

  const handleInstallCli = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      await installVercelCli();
      onVercelConnect();
      onToast?.("Vercel CLI installed!", "success");
    } catch (e) {
      setError(String(e));
      onToast?.("Failed to install Vercel CLI", "error");
    } finally {
      setIsInstalling(false);
    }
  };

  const handleStartLogin = async () => {
    setShowLoginModal(true);
    setLoginOutput([]);
    setIsLoggingIn(true);
    setError(null);

    try {
      const homeDir = await invoke<string>("get_marketingstack_dir");
      const parentDir = homeDir.replace("/Marketingstack", "");

      const ptyId = await invoke<number>("spawn_pty", {
        cwd: parentDir,
        command: "vercel",
        args: ["login"],
        rows: 24,
        cols: 80,
      });
      ptyIdRef.current = ptyId;

      const unlistenOutput = await listen<{ id: number; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.id === ptyId) {
            setLoginOutput((prev) => [...prev, event.payload.data]);
          }
        }
      );

      const unlistenExit = await listen<{ id: number; code: number | null }>(
        "pty-exit",
        async (event) => {
          if (event.payload.id === ptyId) {
            ptyIdRef.current = null;
            setIsLoggingIn(false);

            // Clean up listeners
            unlistenOutput();
            unlistenExit();
            ptyListenersRef.current = {};

            const status = await checkVercelCliStatus();
            if (status.authenticated) {
              setShowLoginModal(false);
              onVercelConnect();
              onToast?.("Connected to Vercel!", "success");
            }
          }
        }
      );

      // Store listeners for cleanup on unmount
      ptyListenersRef.current = { unlistenOutput, unlistenExit };
    } catch (e) {
      setError(String(e));
      setIsLoggingIn(false);
    }
  };

  const handleCloseLoginModal = async () => {
    if (ptyIdRef.current !== null) {
      await invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      ptyIdRef.current = null;
    }
    setShowLoginModal(false);
    setIsLoggingIn(false);
    onVercelConnect();
    onModalClose?.();
  };

  const handleDeploy = async () => {
    if (!deployName.trim()) return;

    setIsDeploying(true);
    setError(null);
    setShowDeployModal(false);
    try {
      const deployedUrl = await deployToVercel({
        projectPath,
        projectName: deployName,
        githubRepo: projectGithubStatus?.github_repo || undefined,
      });
      onStatusChange(deployedUrl);
      onToast?.("Connected to Vercel!", "success");
    } catch (e) {
      setError(String(e));
      onToast?.("Failed to connect to Vercel", "error");
    } finally {
      setIsDeploying(false);
    }
  };

  // If Vercel CLI not installed
  if (!cliStatus.installed) {
    return (
      <>
        <button
          className="vercel-button vercel-install"
          onClick={handleInstallCli}
          disabled={isInstalling}
          title="Install Vercel CLI via npm"
        >
          <VercelIcon />
          {isInstalling ? "Installing..." : "Install Vercel"}
        </button>
        {error && <span className="vercel-error">{error}</span>}
      </>
    );
  }

  // If not authenticated
  if (!cliStatus.authenticated) {
    return (
      <>
        <button
          className="vercel-button vercel-connect"
          onClick={handleStartLogin}
          disabled={isLoggingIn}
          title="Connect your Vercel account"
        >
          <VercelIcon />
          {isLoggingIn ? "Connecting..." : "Connect Vercel"}
        </button>

        {showLoginModal && (
          <div className="modal-overlay" onClick={handleCloseLoginModal}>
            <div className="modal vercel-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Connect to Vercel</h3>
              <p>Follow the prompts below to log in to your Vercel account.</p>

              <div className="vercel-login-output" ref={outputRef}>
                {loginOutput.map((line, i) => (
                  <span key={i}>{line}</span>
                ))}
                {isLoggingIn && <span className="cursor">▋</span>}
              </div>

              <div className="modal-actions">
                <button onClick={handleCloseLoginModal}>
                  {isLoggingIn ? "Cancel" : "Close"}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // If deploying
  if (isDeploying) {
    return (
      <button className="vercel-button vercel-deploying" disabled title="Deploying to Vercel...">
        <VercelIcon />
        <span className="deploying-text">Deploying...</span>
      </button>
    );
  }

  // If auto-connecting after GitHub repo creation
  if (isAutoConnecting) {
    return (
      <button className="vercel-button vercel-deploying" disabled title="Connecting to Vercel...">
        <VercelIcon />
        <span className="deploying-text">Connecting...</span>
      </button>
    );
  }

  // If project is fully connected to Vercel (linked + git connected), show icon to open dashboard
  if (projectVercelStatus?.status === "connected") {
    const dashboardUrl = projectVercelStatus.vercel_org && projectVercelStatus.project_name
      ? `https://vercel.com/${projectVercelStatus.vercel_org}/${projectVercelStatus.project_name}`
      : "https://vercel.com/dashboard";
    return (
      <button
        className="vercel-button vercel-linked"
        onClick={() => openUrl(dashboardUrl)}
        title="Open Vercel dashboard"
      >
        <VercelIcon />
      </button>
    );
  }

  // Still checking Vercel status - show loading state
  if (projectVercelStatus === null) {
    return (
      <button className="vercel-button vercel-checking" disabled title="Checking Vercel status...">
        <VercelIcon />
        <span className="checking-text">Connecting...</span>
      </button>
    );
  }

  // Not linked yet - show Connect button to set up Vercel project
  return (
    <>
      <button
        className="vercel-button vercel-setup"
        onClick={() => {
          setDeployName(projectName);
          setShowDeployModal(true);
          setError(null);
        }}
        title="Connect to Vercel for auto-deployments"
      >
        <VercelIcon />
        Connect Vercel
      </button>

      {showDeployModal && (
        <div className="modal-overlay" onClick={() => { if (!isDeploying) { setShowDeployModal(false); onModalClose?.(); } }}>
          <div className="modal vercel-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Connect to Vercel</h3>
            <p>Link this project to Vercel for automatic deployments when you publish.</p>

            <div className="vercel-form">
              <label>
                Vercel project name
                <input
                  type="text"
                  value={deployName}
                  onChange={(e) =>
                    setDeployName(e.target.value.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase())
                  }
                  placeholder="my-project"
                  autoFocus
                />
              </label>

              {projectGithubStatus?.github_repo && (
                <div className="vercel-github-info">
                  <span className="vercel-github-label">Connected to GitHub:</span>
                  <span className="vercel-github-repo">{projectGithubStatus.github_repo}</span>
                  <span className="vercel-github-note">Auto-deploys on push will be enabled</span>
                </div>
              )}

              {error && <p className="vercel-error">{error}</p>}
            </div>

            <div className="modal-actions">
              <button onClick={() => { setShowDeployModal(false); onModalClose?.(); }} disabled={isDeploying}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowDeployModal(false);
                  handleDeploy();
                  onModalClose?.();
                }}
                disabled={isDeploying || !deployName.trim()}
              >
                Connect & Deploy
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function VercelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 116 100" fill="currentColor">
      <path d="M57.5 0L115 100H0L57.5 0Z" />
    </svg>
  );
}
