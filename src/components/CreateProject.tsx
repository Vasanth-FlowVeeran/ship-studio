import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface CreateProjectProps {
  onComplete: (projectPath: string) => void;
  onCancel: () => void;
}

const TEMPLATE_REPO = "https://github.com/marketingstack/marketingstack-boilerplate";

type Step = "clone" | "init" | "install" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "clone", label: "Clone template" },
  { id: "init", label: "Initialize project" },
  { id: "install", label: "Install dependencies" },
  { id: "done", label: "Done" },
];

// Status messages for each step
const STATUS_MESSAGES: Record<Step, string> = {
  clone: "Downloading template...",
  init: "Setting up project...",
  install: "Installing dependencies... This may take a minute.",
  done: "Almost done...",
};

export function CreateProject({ onComplete, onCancel }: CreateProjectProps) {
  const [projectName, setProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [currentStep, setCurrentStep] = useState<Step>("clone");
  const [error, setError] = useState<string | null>(null);

  const waitForPtyExit = async (targetId: number): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      let unlisten: UnlistenFn | null = null;

      listen<{ id: number; code: number | null }>("pty-exit", (event) => {
        if (event.payload.id === targetId) {
          unlisten?.();
          if (event.payload.code === 0 || event.payload.code === null) {
            resolve(event.payload.code);
          } else {
            reject(new Error(`Process exited with code ${event.payload.code}`));
          }
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });
  };

  const handleCreate = async () => {
    if (!projectName.trim()) {
      setError("Please enter a project name");
      return;
    }

    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!safeName) {
      setError("Invalid project name");
      return;
    }

    // Check for duplicate project names
    try {
      const existingProjects = await invoke<{ name: string; path: string }[]>("list_projects");
      const duplicate = existingProjects.find(p => p.name.toLowerCase() === safeName.toLowerCase());
      if (duplicate) {
        setError(`A project named "${safeName}" already exists`);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }

    setIsCreating(true);
    setError(null);
    setCurrentStep("clone");

    try {
      // Ensure Marketingstack directory exists
      const marketingstackDir = await invoke<string>("ensure_marketingstack_dir");
      const projectPath = `${marketingstackDir}/${safeName}`;

      // Clone template
      const cloneId = await invoke<number>("spawn_pty", {
        options: {
          cwd: marketingstackDir,
          command: "git",
          args: ["clone", TEMPLATE_REPO, safeName],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(cloneId);

      // Remove .git folder so project starts fresh (not connected to template repo)
      setCurrentStep("init");
      const rmGitId = await invoke<number>("spawn_pty", {
        options: {
          cwd: projectPath,
          command: "rm",
          args: ["-rf", ".git"],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(rmGitId);

      // Install dependencies
      setCurrentStep("install");
      const installId = await invoke<number>("spawn_pty", {
        options: {
          cwd: projectPath,
          command: "npm",
          args: ["install"],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(installId);

      setCurrentStep("done");

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const getStepStatus = (stepId: Step): "pending" | "active" | "done" => {
    const stepOrder = STEPS.map((s) => s.id);
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return "done";
    if (stepIndex === currentIndex) return "active";
    return "pending";
  };

  if (isCreating) {
    return (
      <div className="create-project creating">
        <div className="create-loading">
          <h2>Creating "{projectName}"</h2>

          <div className="create-spinner" />

          <p className="create-status">{STATUS_MESSAGES[currentStep]}</p>

          <div className="create-checklist">
            {STEPS.slice(0, -1).map((step) => {
              const status = getStepStatus(step.id);
              return (
                <div key={step.id} className={`checklist-item ${status}`}>
                  {status === "done" ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : status === "active" ? (
                    <div className="checklist-spinner" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                    </svg>
                  )}
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="create-error">
              <p>{error}</p>
              <button onClick={onCancel}>Back</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="create-project">
      <h2>New Project</h2>
      <p>Create a new Next.js site with Claude Code</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <label>
          Project Name
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-awesome-site"
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="create-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            Create Project
          </button>
        </div>
      </form>
    </div>
  );
}
