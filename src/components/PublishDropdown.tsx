import { useState, useEffect, useRef, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ProjectGitHubStatus,
  BranchStatus,
  getBranchStatus,
  publishToStaging,
  publishToProduction,
} from "../lib/github";
import { ProjectVercelStatus } from "../lib/vercel";

interface PublishDropdownProps {
  projectGithubStatus: ProjectGitHubStatus | null;
  projectVercelStatus: ProjectVercelStatus | null;
  projectPath: string;
  onStatusChange: () => void;
  onModalClose?: () => void;
  onToast?: (message: string, type?: "success" | "error") => void;
  isPublishing: boolean;
  setIsPublishing: (publishing: boolean) => void;
}

type PublishState =
  | { status: "idle" }
  | { status: "publishing"; target: "staging" | "production" | "both" }
  | { status: "success"; target: "staging" | "production" | "both" }
  | { status: "error"; message: string };

export function PublishDropdown({
  projectGithubStatus,
  projectVercelStatus,
  projectPath,
  onStatusChange,
  onModalClose,
  onToast,
  isPublishing,
  setIsPublishing,
}: PublishDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [stagingChecked, setStagingChecked] = useState(true);
  const [productionChecked, setProductionChecked] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: "idle" });
  const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasGitHubRepo = projectGithubStatus?.status === "connected" && projectGithubStatus?.github_repo;
  const hasVercel = projectVercelStatus?.status === "connected";

  // Fetch branch status when dropdown opens
  const fetchBranchStatus = useCallback(async () => {
    if (!projectPath || !hasGitHubRepo) return;
    try {
      const status = await getBranchStatus(projectPath);
      setBranchStatus(status);
    } catch (e) {
      console.error("Failed to get branch status:", e);
    }
  }, [projectPath, hasGitHubRepo]);

  // Reset state when project changes
  useEffect(() => {
    setPublishState({ status: "idle" });
    setBranchStatus(null);
    setIsOpen(false);
  }, [projectPath]);

  // Fetch status when dropdown opens
  useEffect(() => {
    if (isOpen && hasGitHubRepo) {
      fetchBranchStatus();
    }
  }, [isOpen, hasGitHubRepo, fetchBranchStatus]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        onModalClose?.();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onModalClose]);

  const handlePublish = async () => {
    if (!stagingChecked && !productionChecked) return;

    const target = stagingChecked && productionChecked ? "both" : stagingChecked ? "staging" : "production";

    setIsPublishing(true);
    setPublishState({ status: "publishing", target });

    try {
      // Push to staging if selected
      if (stagingChecked) {
        const result = await publishToStaging(projectPath);
        if (result.state === "ERROR") {
          throw new Error("Failed to push to staging branch");
        }
      }

      // Push to production if selected
      if (productionChecked) {
        const result = await publishToProduction(projectPath);
        if (result.state === "ERROR") {
          throw new Error("Failed to push to main branch");
        }
      }

      // Give Vercel a moment to register the deployment before showing success
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Success!
      setPublishState({ status: "success", target });
      onToast?.(
        target === "both"
          ? "Pushed to staging and production!"
          : `Pushed to ${target}!`,
        "success"
      );

      // Refresh branch status
      await fetchBranchStatus();
      onStatusChange();

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPublishState({ status: "error", message });
      onToast?.("Push failed", "error");
    } finally {
      setIsPublishing(false);
    }
  };

  const handleTryAgain = () => {
    setPublishState({ status: "idle" });
  };

  // Vercel URLs - fetched from `vercel alias ls` for real URLs including custom domains
  const vercelOrg = projectVercelStatus?.vercel_org;
  const vercelProjectName = projectVercelStatus?.project_name;
  const vercelDashboardUrl = vercelOrg && vercelProjectName
    ? `https://vercel.com/${vercelOrg}/${vercelProjectName}/deployments`
    : null;
  const stagingUrl = projectVercelStatus?.staging_url
    ? `https://${projectVercelStatus.staging_url}`
    : null;
  const productionUrl = projectVercelStatus?.production_url
    ? `https://${projectVercelStatus.production_url}`
    : null;

  // Determine if there are changes to push
  const hasChanges = branchStatus?.local_changes ||
    (branchStatus?.staging_ahead ?? 0) > 0 ||
    (branchStatus?.main_ahead ?? 0) > 0;

  // If no GitHub repo, show disabled state
  if (!hasGitHubRepo) {
    return (
      <div className="publish-dropdown" ref={dropdownRef}>
        <button
          className="publish-button publish-disabled"
          disabled
          title="Create a GitHub repository first"
        >
          Publish
          <ChevronIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="publish-dropdown" ref={dropdownRef}>
      <button
        className={`publish-button ${isPublishing ? 'publishing' : ''} ${!hasChanges && !isOpen ? 'no-changes' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isPublishing ? "Publishing..." : "Publish"}
        <ChevronIcon />
      </button>

      {isOpen && (
        <div className="publish-dropdown-menu">
          {/* Success State */}
          {publishState.status === "success" && (
            <>
              <div className="publish-success">
                <SuccessIcon />
                <span>
                  Pushed to {publishState.target === "both" ? "staging & production" : publishState.target}
                </span>
              </div>
              {hasVercel && (
                <div className="publish-success-message">
                  Vercel is deploying your changes.<br />
                  This usually takes 1-2 minutes.
                </div>
              )}
              {hasVercel && vercelDashboardUrl && (
                <div className="publish-success-vercel">
                  <button
                    className="publish-vercel-button"
                    onClick={() => openUrl(vercelDashboardUrl)}
                  >
                    <VercelIcon />
                    View Deployments
                    <ExternalLinkIcon />
                  </button>
                </div>
              )}
              <div className="publish-success-sites">
                {(publishState.target === "staging" || publishState.target === "both") && (
                  stagingUrl ? (
                    <button
                      className="publish-link-button"
                      onClick={() => {
                        navigator.clipboard.writeText(stagingUrl);
                        onToast?.("Staging URL copied", "success");
                      }}
                    >
                      <CopyIcon />
                      Copy Staging URL
                    </button>
                  ) : (
                    <button className="publish-link-button publish-link-loading" disabled>
                      <SmallSpinnerIcon />
                      Loading Staging URL...
                    </button>
                  )
                )}
                {(publishState.target === "production" || publishState.target === "both") && (
                  productionUrl ? (
                    <button
                      className="publish-link-button"
                      onClick={() => {
                        navigator.clipboard.writeText(productionUrl);
                        onToast?.("Production URL copied", "success");
                      }}
                    >
                      <CopyIcon />
                      Copy Production URL
                    </button>
                  ) : (
                    <button className="publish-link-button publish-link-loading" disabled>
                      <SmallSpinnerIcon />
                      Loading Production URL...
                    </button>
                  )
                )}
              </div>
              <div className="publish-actions publish-actions-center">
                <button
                  className="publish-done"
                  onClick={() => {
                    setIsOpen(false);
                    setPublishState({ status: "idle" });
                    onModalClose?.();
                  }}
                >
                  Done
                </button>
              </div>
            </>
          )}

          {/* Error State */}
          {publishState.status === "error" && (
            <>
              <div className="publish-error-header">
                <ErrorIcon />
                <span>Failed to publish</span>
              </div>
              <div className="publish-error-message">
                {publishState.message}
              </div>
              <div className="publish-actions">
                <button
                  className="publish-close"
                  onClick={() => {
                    setIsOpen(false);
                    setPublishState({ status: "idle" });
                    onModalClose?.();
                  }}
                >
                  Close
                </button>
                <button
                  className="publish-submit"
                  onClick={handleTryAgain}
                >
                  Try Again
                </button>
              </div>
            </>
          )}

          {/* Publishing State */}
          {publishState.status === "publishing" && (
            <>
              <div className="publish-in-progress-header">
                <SpinnerIcon />
                <span>
                  Publishing to {publishState.target === "both" ? "staging & production" : publishState.target}...
                </span>
              </div>
              <div className="publish-actions">
                <button
                  className="publish-close"
                  onClick={() => {
                    setIsOpen(false);
                    onModalClose?.();
                  }}
                >
                  Close
                </button>
              </div>
            </>
          )}

          {/* Idle State - Loading */}
          {publishState.status === "idle" && !branchStatus && (
            <div className="publish-loading">
              <div className="publish-loading-spinner" />
              <span>Loading...</span>
            </div>
          )}

          {/* Idle State - Selection UI */}
          {publishState.status === "idle" && branchStatus && (() => {
            // Determine if there are changes to push for each target
            // Include local_changes because publish auto-commits before pushing
            const hasLocalChanges = branchStatus?.local_changes ?? false;
            const canPushToStaging = !branchStatus.staging_exists || branchStatus.staging_ahead > 0 || hasLocalChanges;
            const canPushToProduction = branchStatus.main_ahead > 0 || hasLocalChanges;

            // Can only publish if selected targets have changes
            const wouldPublishSomething =
              (stagingChecked && canPushToStaging) ||
              (productionChecked && canPushToProduction);

            return (
              <>
                {/* Staging Row */}
                <label className={`publish-row ${!canPushToStaging ? 'publish-row-disabled' : ''}`}>
                  <div className="publish-row-left">
                    <input
                      type="checkbox"
                      checked={stagingChecked}
                      onChange={(e) => setStagingChecked(e.target.checked)}
                      disabled={isPublishing || !canPushToStaging}
                    />
                    <span className="publish-row-label">Staging</span>
                    {branchStatus && (branchStatus.staging_ahead > 0 || !branchStatus.staging_exists || hasLocalChanges) ? (
                      <span className="publish-row-badge">
                        {!branchStatus.staging_exists ? "new" :
                         hasLocalChanges && branchStatus.staging_ahead === 0 ? "changes" :
                         hasLocalChanges ? `${branchStatus.staging_ahead}+ ahead` :
                         `${branchStatus.staging_ahead} ahead`}
                      </span>
                    ) : branchStatus && (
                      <span className="publish-row-badge publish-row-badge-synced">up to date</span>
                    )}
                  </div>
                  {hasVercel && stagingUrl && (
                    <button
                      className="publish-row-link"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openUrl(stagingUrl);
                      }}
                      title="Open staging site"
                    >
                      <ExternalLinkIcon />
                    </button>
                  )}
                </label>

                {/* Production Row */}
                <label className={`publish-row ${!canPushToProduction ? 'publish-row-disabled' : ''}`}>
                  <div className="publish-row-left">
                    <input
                      type="checkbox"
                      checked={productionChecked}
                      onChange={(e) => setProductionChecked(e.target.checked)}
                      disabled={isPublishing || !canPushToProduction}
                    />
                    <span className="publish-row-label">Production</span>
                    {branchStatus && (branchStatus.main_ahead > 0 || hasLocalChanges) ? (
                      <span className="publish-row-badge">
                        {hasLocalChanges && branchStatus.main_ahead === 0 ? "changes" :
                         hasLocalChanges ? `${branchStatus.main_ahead}+ ahead` :
                         `${branchStatus.main_ahead} ahead`}
                      </span>
                    ) : branchStatus && (
                      <span className="publish-row-badge publish-row-badge-synced">up to date</span>
                    )}
                  </div>
                  {hasVercel && productionUrl && (
                    <button
                      className="publish-row-link"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openUrl(productionUrl);
                      }}
                      title="Open production site"
                    >
                      <ExternalLinkIcon />
                    </button>
                  )}
                </label>

                {/* Actions */}
                <div className="publish-actions">
                  {hasVercel && vercelDashboardUrl && (
                    <button
                      className="publish-deployments-link"
                      onClick={() => openUrl(vercelDashboardUrl)}
                    >
                      Deployments
                      <ExternalLinkIcon />
                    </button>
                  )}
                  <div className="publish-actions-right">
                    <button
                      className="publish-submit"
                      onClick={handlePublish}
                      disabled={isPublishing || !wouldPublishSomething}
                    >
                      Publish
                    </button>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spinner-icon">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function VercelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 116 100" fill="currentColor">
      <path d="M57.5 0L115 100H0L57.5 0z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SmallSpinnerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spinner-icon">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
