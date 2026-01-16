import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitHubState, VercelState, ClaudeState } from "../App";
import { installVercelCli, checkVercelCliStatus } from "../lib/vercel";
import { installClaudeCli } from "../lib/claude";

interface Project {
  name: string;
  path: string;
  thumbnail: string | null;
}

interface ProjectWithThumbnail extends Project {
  thumbnailData: string | null;
}

interface ProjectListProps {
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
  githubState: GitHubState;
  vercelState: VercelState;
  claudeState: ClaudeState;
  onGitHubConnect: () => void;
  onVercelConnect: () => void;
  onClaudeConnect: () => void;
}

export function ProjectList({
  onSelectProject,
  onCreateProject,
  githubState,
  vercelState,
  claudeState,
  onGitHubConnect,
  onVercelConnect,
  onClaudeConnect,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingProject, setOpeningProject] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Vercel login modal state
  const [showVercelLogin, setShowVercelLogin] = useState(false);
  const [vercelLoginOutput, setVercelLoginOutput] = useState<string[]>([]);
  const [isVercelLoggingIn, setIsVercelLoggingIn] = useState(false);
  const [isInstallingVercel, setIsInstallingVercel] = useState(false);

  // Claude install state
  const [isInstallingClaude, setIsInstallingClaude] = useState(false);
  const ptyIdRef = useRef<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll vercel login output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [vercelLoginOutput]);

  // Cleanup PTY on unmount
  useEffect(() => {
    return () => {
      if (ptyIdRef.current !== null) {
        invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      }
    };
  }, []);

  const loadProjects = async () => {
    try {
      const projectList = await invoke<Project[]>("list_projects");

      // Load thumbnails for each project
      const projectsWithThumbnails = await Promise.all(
        projectList.map(async (project) => {
          let thumbnailData: string | null = null;
          if (project.thumbnail) {
            try {
              thumbnailData = await invoke<string | null>("get_project_thumbnail", {
                projectPath: project.path,
              });
            } catch (e) {
              console.error("Failed to load thumbnail for", project.name, e);
            }
          }
          return { ...project, thumbnailData };
        })
      );

      setProjects(projectsWithThumbnails);
    } catch (error) {
      console.error("Failed to load projects:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleOpenProject = (project: Project) => {
    setOpeningProject(project.path);
    onSelectProject(project);
  };

  const handleDelete = async (project: Project) => {
    setDeleting(true);
    try {
      await invoke("delete_project", { path: project.path });
      setDeleteConfirm(null);
      await loadProjects();
    } catch (error) {
      console.error("Failed to delete project:", error);
      alert("Failed to delete project: " + error);
    } finally {
      setDeleting(false);
    }
  };

  const handleInstallClaude = async () => {
    setIsInstallingClaude(true);
    try {
      await installClaudeCli();
      onClaudeConnect();
    } catch (e) {
      console.error("Failed to install Claude Code:", e);
    } finally {
      setIsInstallingClaude(false);
    }
  };

  const handleInstallVercel = async () => {
    setIsInstallingVercel(true);
    try {
      await installVercelCli();
      onVercelConnect();
    } catch (e) {
      console.error("Failed to install Vercel CLI:", e);
    } finally {
      setIsInstallingVercel(false);
    }
  };

  const handleVercelLogin = async () => {
    setShowVercelLogin(true);
    setVercelLoginOutput([]);
    setIsVercelLoggingIn(true);

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
            setVercelLoginOutput((prev) => [...prev, event.payload.data]);
          }
        }
      );

      const unlistenExit = await listen<{ id: number; code: number | null }>(
        "pty-exit",
        async (event) => {
          if (event.payload.id === ptyId) {
            ptyIdRef.current = null;
            setIsVercelLoggingIn(false);
            unlistenOutput();
            unlistenExit();

            const status = await checkVercelCliStatus();
            if (status.authenticated) {
              setShowVercelLogin(false);
              onVercelConnect();
            }
          }
        }
      );
    } catch (e) {
      console.error("Failed to start Vercel login:", e);
      setIsVercelLoggingIn(false);
    }
  };

  const handleCloseVercelLogin = async () => {
    if (ptyIdRef.current !== null) {
      await invoke("kill_pty", { id: ptyIdRef.current }).catch(() => {});
      ptyIdRef.current = null;
    }
    setShowVercelLogin(false);
    setIsVercelLoggingIn(false);
    onVercelConnect();
  };

  if (loading) {
    return (
      <div className="project-list-loading">
        <div className="spinner" />
        <p>Loading projects...</p>
      </div>
    );
  }

  return (
    <div className="project-list">
      <div className="project-list-header">
        <h1>Marketingstack</h1>
        <p>Build AI native marketing sites easily with SOTA technology.</p>
      </div>

      {/* Connections Dashboard */}
      <div className="connections-dashboard">
        {/* Claude Connection */}
        <div className={`connection-card ${claudeState.cliStatus.installed ? 'connected' : 'disconnected'}`}>
          <div className="connection-icon">
            <ClaudeIcon />
          </div>
          <div className="connection-info">
            <span className="connection-name">Claude</span>
            {claudeState.cliStatus.installed ? (
              <span className="connection-status">
                {claudeState.cliStatus.version || 'Connected'}
              </span>
            ) : (
              <span className="connection-status disconnected">Not installed</span>
            )}
          </div>
          {!claudeState.cliStatus.installed && (
            <button
              className="connection-action"
              onClick={handleInstallClaude}
              disabled={isInstallingClaude}
            >
              {isInstallingClaude ? 'Installing...' : 'Install'}
            </button>
          )}
        </div>

        {/* GitHub Connection */}
        <div className={`connection-card ${githubState.cliStatus.authenticated ? 'connected' : 'disconnected'}`}>
          <div className="connection-icon">
            <GitHubIcon />
          </div>
          <div className="connection-info">
            <span className="connection-name">GitHub</span>
            {!githubState.cliStatus.installed ? (
              <span className="connection-status disconnected">CLI not installed</span>
            ) : !githubState.cliStatus.authenticated ? (
              <span className="connection-status disconnected">Not connected</span>
            ) : (
              <span className="connection-status">{githubState.username}</span>
            )}
          </div>
          {!githubState.cliStatus.installed ? (
            <button
              className="connection-action"
              onClick={() => openUrl("https://cli.github.com/")}
            >
              Install
            </button>
          ) : !githubState.cliStatus.authenticated ? (
            <button
              className="connection-action"
              onClick={() => {
                openUrl("https://github.com/login/device");
                const pollAuth = async () => {
                  for (let i = 0; i < 60; i++) {
                    await new Promise((r) => setTimeout(r, 2000));
                    onGitHubConnect();
                  }
                };
                pollAuth();
              }}
            >
              Connect
            </button>
          ) : null}
        </div>

        {/* Vercel Connection */}
        <div className={`connection-card ${vercelState.cliStatus.authenticated ? 'connected' : 'disconnected'}`}>
          <div className="connection-icon">
            <VercelIcon />
          </div>
          <div className="connection-info">
            <span className="connection-name">Vercel</span>
            {!vercelState.cliStatus.installed ? (
              <span className="connection-status disconnected">CLI not installed</span>
            ) : !vercelState.cliStatus.authenticated ? (
              <span className="connection-status disconnected">Not connected</span>
            ) : (
              <span className="connection-status">{vercelState.username || 'Connected'}</span>
            )}
          </div>
          {!vercelState.cliStatus.installed ? (
            <button
              className="connection-action"
              onClick={handleInstallVercel}
              disabled={isInstallingVercel}
            >
              {isInstallingVercel ? 'Installing...' : 'Install'}
            </button>
          ) : !vercelState.cliStatus.authenticated ? (
            <button
              className="connection-action"
              onClick={handleVercelLogin}
            >
              Connect
            </button>
          ) : null}
        </div>
      </div>

      <div className="project-list-actions">
        <button className="btn-primary" onClick={onCreateProject}>
          + New Project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="project-list-empty">
          <p>No projects yet</p>
          <p className="hint">Create your first project to get started</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <div key={project.path} className="project-card">
              <button
                className="project-card-thumbnail"
                onClick={() => handleOpenProject(project)}
                disabled={openingProject !== null}
              >
                {openingProject === project.path ? (
                  <div className="project-card-placeholder">
                    <div className="spinner" />
                    <span>Opening...</span>
                  </div>
                ) : project.thumbnailData ? (
                  <img
                    src={project.thumbnailData}
                    alt={project.name}
                  />
                ) : (
                  <div className="project-card-placeholder">
                    <span>No preview</span>
                  </div>
                )}
              </button>
              <div className="project-card-info">
                <div className="project-card-details">
                  <span className="project-card-name">{project.name}</span>
                  <span className="project-card-path">{project.path}</span>
                </div>
                <button
                  className="project-card-menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(project);
                  }}
                  title="Delete project"
                >
                  •••
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Project?</h3>
            <p>
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
            </p>
            <p className="hint">This will permanently delete all files in this project.</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirm(null)} disabled={deleting}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => handleDelete(deleteConfirm)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vercel Login Modal */}
      {showVercelLogin && (
        <div className="modal-overlay" onClick={handleCloseVercelLogin}>
          <div className="modal vercel-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Connect to Vercel</h3>
            <p>Follow the prompts below to log in to your Vercel account.</p>

            <div className="vercel-login-output" ref={outputRef}>
              {vercelLoginOutput.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
              {isVercelLoggingIn && <span className="cursor">▋</span>}
            </div>

            <div className="modal-actions">
              <button onClick={handleCloseVercelLogin}>
                {isVercelLoggingIn ? "Cancel" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClaudeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 1200 1200" fill="#d97757">
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function VercelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 116 100" fill="currentColor">
      <path d="M57.5 0L115 100H0L57.5 0Z" />
    </svg>
  );
}
