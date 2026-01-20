import { DashboardProject } from "../lib/project";

interface ProjectCardProps {
  project: DashboardProject;
  thumbnailData: string | null;
  onSelect: () => void;
  onDelete: () => void;
  onOpenSite?: () => void;
  onOpenIde?: () => void;
}

export function ProjectCard({
  project,
  thumbnailData,
  onSelect,
  onDelete,
  onOpenSite,
  onOpenIde,
}: ProjectCardProps) {
  const hasChanges = project.uncommitted_count && project.uncommitted_count > 0;

  return (
    <div className="project-card">
      <div
        className="project-card-thumbnail"
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        {thumbnailData ? (
          <img src={thumbnailData} alt={project.name} />
        ) : (
          <div className="project-card-placeholder">
            <span>No preview</span>
          </div>
        )}
        {/* Hover actions overlay */}
        <div className="project-card-overlay">
          <div className="project-card-quick-actions">
            {project.production_url && onOpenSite && (
              <button
                className="quick-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSite();
                }}
                title="Open live site"
              >
                <ExternalLinkIcon />
              </button>
            )}
            {onOpenIde && (
              <button
                className="quick-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenIde();
                }}
                title="Open in IDE"
              >
                <CodeIcon />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="project-card-info">
        <div className="project-card-details">
          <span className="project-card-name">{project.name}</span>
          <div className="project-card-meta">
            {project.git_branch && (
              <span className="project-card-branch">
                <BranchIcon />
                {project.git_branch}
              </span>
            )}
            {hasChanges && (
              <span className="project-card-changes">
                {project.uncommitted_count} uncommitted
              </span>
            )}
          </div>
          <div className="project-card-deployment">
            {project.deployment_state ? (
              <>
                <span
                  className={`status-dot status-${project.deployment_state.toLowerCase()}`}
                />
                {project.production_url ? (
                  <span className="project-card-url">
                    {formatUrl(project.production_url)}
                  </span>
                ) : (
                  <span className="project-card-deploy-time">
                    {project.last_deployed}
                  </span>
                )}
              </>
            ) : (
              <span className="project-card-not-deployed">Not deployed</span>
            )}
          </div>
        </div>
        <button
          className="project-card-menu"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete project"
        >
          &bull;&bull;&bull;
        </button>
      </div>
    </div>
  );
}

function formatUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function BranchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
