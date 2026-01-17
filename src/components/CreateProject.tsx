import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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

export function CreateProject({ onComplete, onCancel }: CreateProjectProps) {
  const [projectName, setProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [currentStep, setCurrentStep] = useState<Step>("clone");
  const [error, setError] = useState<string | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!isCreating || !termRef.current) return;

    const term = new XTerm({
      cursorBlink: false,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      disableStdin: true,
      theme: {
        background: "#0d0d14",
        foreground: "#a0a0b0",
        cursor: "#a0a0b0",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    return () => {
      term.dispose();
    };
  }, [isCreating]);

  const writeLine = (text: string) => {
    xtermRef.current?.write(text + "\r\n");
  };

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

    setIsCreating(true);
    setError(null);
    setCurrentStep("clone");

    let unlistenOutput: UnlistenFn | null = null;

    try {
      // Ensure Marketingstack directory exists
      const marketingstackDir = await invoke<string>("ensure_marketingstack_dir");
      const projectPath = `${marketingstackDir}/${safeName}`;

      writeLine(`Creating project: ${safeName}`);
      writeLine(`Location: ${projectPath}`);
      writeLine("");

      // Clone template
      writeLine("$ git clone template...");

      unlistenOutput = await listen<{ id: number; data: string }>(
        "pty-output",
        (event) => {
          xtermRef.current?.write(event.payload.data);
        }
      );

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
      writeLine("");
      writeLine("$ Initializing project...");
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

      setCurrentStep("install");
      writeLine("");
      writeLine("$ npm install");

      // Install dependencies
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
      writeLine("");
      writeLine("\x1b[32mProject created successfully!\x1b[0m");

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 1000));
      onComplete(projectPath);
    } catch (err) {
      writeLine("");
      writeLine(`\x1b[31mError: ${err}\x1b[0m`);
      setError(String(err));
    } finally {
      if (unlistenOutput) {
        unlistenOutput();
      }
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
        <div className="create-header">
          <h2>Creating {projectName}</h2>
          <p>Setting up your new project</p>
        </div>

        <div className="create-steps">
          {STEPS.map((step, index) => {
            const status = getStepStatus(step.id);
            return (
              <div key={step.id} className={`create-step ${status}`}>
                <div className="step-indicator">
                  {status === "done" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : status === "active" ? (
                    <div className="step-spinner" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span className="step-label">{step.label}</span>
              </div>
            );
          })}
        </div>

        <div ref={termRef} className="create-terminal" />

        {error && (
          <div className="create-error">
            <p>{error}</p>
            <button onClick={onCancel}>Back</button>
          </div>
        )}
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
