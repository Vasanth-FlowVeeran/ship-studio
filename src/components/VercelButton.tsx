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

  const { cliStatus } = vercelState;

  // Auto-scroll login output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [loginOutput]);

  // Cleanup PTY on unmount
  useEffect(() => {
    return () => {
      if (ptyIdRef.current !== null) {
        invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      }
    };
  }, []);

  // Don't show any Vercel options until GitHub repo is created
  // Vercel deployments are tied to GitHub for auto-deploy
  if (!projectGithubStatus?.has_remote || !projectGithubStatus?.github_repo) {
    return null;
  }

  const handleInstallCli = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      await installVercelCli();
      onVercelConnect(); // Refresh status
    } catch (e) {
      setError(String(e));
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
      // Get home directory for running vercel login
      const homeDir = await invoke<string>("get_marketingstack_dir");
      const parentDir = homeDir.replace("/Marketingstack", "");

      // Spawn PTY for vercel login
      const ptyId = await invoke<number>("spawn_pty", {
        cwd: parentDir,
        command: "vercel",
        args: ["login"],
        rows: 24,
        cols: 80,
      });
      ptyIdRef.current = ptyId;

      // Listen for PTY output
      const unlistenOutput = await listen<{ id: number; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.id === ptyId) {
            setLoginOutput((prev) => [...prev, event.payload.data]);
          }
        }
      );

      // Listen for PTY exit
      const unlistenExit = await listen<{ id: number; code: number | null }>(
        "pty-exit",
        async (event) => {
          if (event.payload.id === ptyId) {
            ptyIdRef.current = null;
            setIsLoggingIn(false);
            unlistenOutput();
            unlistenExit();

            // Check if login was successful
            const status = await checkVercelCliStatus();
            if (status.authenticated) {
              setShowLoginModal(false);
              onVercelConnect();
            }
          }
        }
      );
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
    onVercelConnect(); // Refresh status in case login completed
    onModalClose?.();
  };

  const handleDeploy = async () => {
    if (!deployName.trim()) return;

    setIsDeploying(true);
    setError(null);
    setShowDeployModal(false); // Close modal to show deploying state on button
    try {
      console.log("Starting Vercel deployment...", { projectPath, deployName });
      const deployedUrl = await deployToVercel({
        projectPath,
        projectName: deployName,
        githubRepo: projectGithubStatus?.github_repo || undefined,
      });
      console.log("Deployment successful:", deployedUrl);
      onStatusChange(deployedUrl); // Pass the deployed URL
    } catch (e) {
      console.error("Deployment failed:", e);
      setError(String(e));
    } finally {
      setIsDeploying(false);
    }
  };

  // If vercel CLI not installed, show install button
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

  // If not authenticated, show connect button
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

        {/* Login Modal */}
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

  // If project is connected to Vercel and has a URL, show Live button
  if (projectVercelStatus?.is_linked && projectVercelStatus?.production_url) {
    return (
      <button
        className="vercel-button vercel-live"
        onClick={() => {
          if (projectVercelStatus.production_url) {
            openUrl(projectVercelStatus.production_url);
          }
        }}
        title={`Open ${projectVercelStatus.production_url}`}
      >
        <VercelIcon />
        / (Live)
      </button>
    );
  }

  // If currently deploying, show deploying state
  if (isDeploying) {
    return (
      <button
        className="vercel-button vercel-deploying"
        disabled
        title="Deploying to Vercel..."
      >
        <VercelIcon />
        <span className="deploying-text">Deploying...</span>
      </button>
    );
  }

  // If there was a deployment error, show error state with retry
  if (error && !projectVercelStatus?.is_linked) {
    return (
      <>
        <button
          className="vercel-button vercel-error-state"
          onClick={() => {
            setError(null);
            setDeployName(projectName);
            setShowDeployModal(true);
          }}
          title="Deployment failed - click to retry"
        >
          <VercelIcon />
          Deploy Failed
        </button>
        <span className="vercel-error-inline" title={error}>Retry?</span>
      </>
    );
  }

  // Project has GitHub but not connected to Vercel - show Deploy button
  return (
    <>
      <button
        className="vercel-button vercel-deploy"
        onClick={() => {
          setDeployName(projectName);
          setShowDeployModal(true);
          setError(null);
        }}
        title="Deploy this project to Vercel"
      >
        <VercelIcon />
        Deploy to Vercel
      </button>

      {/* Deploy Modal */}
      {showDeployModal && (
        <div className="modal-overlay" onClick={() => { if (!isDeploying) { setShowDeployModal(false); onModalClose?.(); } }}>
          <div className="modal vercel-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Deploy to Vercel</h3>
            <p>Deploy this project to Vercel. Future pushes to GitHub will auto-deploy.</p>

            <div className="vercel-form">
              <label>
                Project name
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
                Deploy
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
