/**
 * Simplified publish dropdown for branch-based workflow.
 *
 * Publishes the current branch to origin. Shows different messaging
 * for main branch (production) vs feature branches.
 *
 * @module components/PublishBranchDropdown
 */

import { useState, useRef, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProjectGitHubStatus } from "../lib/github";
import { ProjectVercelStatus } from "../lib/vercel";
import { publishBranch } from "../lib/branches";
import {
  ChevronIcon,
  BranchIcon,
  ExternalLinkIcon,
  SuccessIcon,
  ErrorIcon,
  SpinnerIcon,
  VercelIcon,
} from "./icons";
import { useClickOutside } from "../hooks/useClickOutside";

interface PublishBranchDropdownProps {
  /** Current branch name */
  currentBranch: string;
  /** Project's GitHub connection status */
  projectGithubStatus: ProjectGitHubStatus | null;
  /** Project's Vercel connection status */
  projectVercelStatus: ProjectVercelStatus | null;
  /** Absolute path to the project */
  projectPath: string;
  /** Callback when publish completes successfully */
  onStatusChange: () => void;
  /** Callback when modal closes */
  onModalClose?: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: "success" | "error") => void;
  /** Publishing state (lifted from parent) */
  isPublishing: boolean;
  /** Set publishing state */
  setIsPublishing: (publishing: boolean) => void;
  /** Callback when a publish error occurs */
  onPublishError?: (error: string, errorType: "push_rejected" | "auth_error" | "merge_conflict" | "generic") => void;
}

type PublishState =
  | { status: "idle" }
  | { status: "publishing" }
  | { status: "success" }
  | { status: "error"; message: string; errorType?: "push_rejected" | "auth_error" | "merge_conflict" | "generic" };

export function PublishBranchDropdown({
  currentBranch,
  projectGithubStatus,
  projectVercelStatus,
  projectPath,
  onStatusChange,
  onModalClose,
  onToast,
  isPublishing,
  setIsPublishing,
  onPublishError,
}: PublishBranchDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({ status: "idle" });
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasGitHubRepo = projectGithubStatus?.status === "connected" && projectGithubStatus?.github_repo;
  const hasVercel = projectVercelStatus?.status === "connected";
  const isMainBranch = currentBranch === "main" || currentBranch === "master";

  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    onModalClose?.();
  }, [onModalClose]);
  useClickOutside(dropdownRef, closeDropdown, isOpen);

  // Generate preview URL for branch
  const getPreviewUrl = (): string | null => {
    if (!hasVercel || !projectVercelStatus?.production_url) {
      return null;
    }
    if (isMainBranch) {
      return `https://${projectVercelStatus.production_url}`;
    }
    // For feature branches, Vercel creates preview URLs
    // Format: project-branch-name.vercel.app
    const projectName = projectVercelStatus.project_name || projectGithubStatus?.github_repo?.split("/")[1];
    if (projectName) {
      const branchSlug = currentBranch.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      return `https://${projectName}-git-${branchSlug}.vercel.app`;
    }
    return null;
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishState({ status: "publishing" });

    try {
      const result = await publishBranch(projectPath);

      // Check for specific error types
      if (result.state === "ERROR") {
        throw new Error("Failed to publish branch");
      }

      // Give Vercel a moment to register the deployment
      await new Promise(resolve => setTimeout(resolve, 2000));

      setPublishState({ status: "success" });
      onToast?.(
        isMainBranch ? "Published to production!" : "Changes synced!",
        "success"
      );
      onStatusChange();

      // Poll for URL updates
      const pollForUrls = async () => {
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          onStatusChange();
        }
      };
      pollForUrls();

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      let errorType: "push_rejected" | "auth_error" | "merge_conflict" | "generic" = "generic";

      if (message.includes("MERGE_CONFLICT")) {
        errorType = "merge_conflict";
      } else if (message.includes("PUSH_REJECTED")) {
        errorType = "push_rejected";
      } else if (message.includes("AUTH_ERROR")) {
        errorType = "auth_error";
      }

      setPublishState({ status: "error", message, errorType });
      onToast?.(isMainBranch ? "Publish failed" : "Sync failed", "error");

      // Notify parent about the error for GitErrorHandler
      if (onPublishError) {
        onPublishError(message, errorType);
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDone = () => {
    setIsOpen(false);
    setPublishState({ status: "idle" });
    onModalClose?.();
  };

  // Vercel URLs
  const vercelOrg = projectVercelStatus?.vercel_org;
  const vercelProjectName = projectVercelStatus?.project_name;
  const vercelDashboardUrl = vercelOrg && vercelProjectName
    ? `https://vercel.com/${vercelOrg}/${vercelProjectName}/deployments`
    : null;
  const previewUrl = getPreviewUrl();

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
        className={`publish-button ${isPublishing ? "publishing" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isPublishing
          ? (isMainBranch ? "Publishing..." : "Syncing...")
          : (isMainBranch ? "Publish" : "Sync")}
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
                  {isMainBranch ? "Published to production" : "Changes synced"}
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
              <div className="publish-actions publish-actions-center">
                <button className="publish-done" onClick={handleDone}>
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
                <span>{isMainBranch ? "Failed to publish" : "Failed to sync"}</span>
              </div>
              <div className="publish-error-message">
                {publishState.errorType === "push_rejected"
                  ? "Push was rejected. Someone else pushed changes to this branch."
                  : publishState.errorType === "auth_error"
                    ? "Authentication failed. Please check your GitHub connection."
                    : publishState.message}
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Close
                </button>
                <button
                  className="publish-submit"
                  onClick={() => setPublishState({ status: "idle" })}
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
                  {isMainBranch ? "Publishing to production..." : "Syncing changes..."}
                </span>
              </div>
              <div className="publish-actions">
                <button className="publish-close" onClick={() => setIsOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {/* Idle State */}
          {publishState.status === "idle" && (
            <>
              <div className="publish-branch-header">
                <h3>{isMainBranch ? "Publish to Production" : "Sync your changes"}</h3>
              </div>

              <div className="publish-branch-body">
                <div className="publish-branch-info">
                  <BranchIcon size={14} />
                  <span className="publish-branch-name">{currentBranch}</span>
                  {isMainBranch && <span className="branch-live-badge">Live</span>}
                </div>

                {isMainBranch && (
                  <div className="publish-branch-warning">
                    This will update your live site. Changes will be visible to everyone.
                  </div>
                )}

                {!isMainBranch && (
                  <div className="publish-branch-description">
                    This will save your work to GitHub so others can see it.
                  </div>
                )}

                {hasVercel && previewUrl && !isMainBranch && (
                  <div className="publish-branch-url">
                    <div className="publish-branch-url-label">Preview URL:</div>
                    <div className="publish-branch-url-value">{previewUrl.replace("https://", "")}</div>
                  </div>
                )}
              </div>

              <div className="publish-actions">
                <button className="publish-close" onClick={handleDone}>
                  Cancel
                </button>
                <button
                  className="publish-submit"
                  onClick={handlePublish}
                  disabled={isPublishing}
                >
                  {isMainBranch ? "Go Live" : "Sync"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
