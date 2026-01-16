import { invoke } from "@tauri-apps/api/core";
import { spawn, IPty } from "tauri-pty";

export interface Project {
  name: string;
  path: string;
  thumbnail: string | null;
}

export interface Prerequisite {
  name: string;
  available: boolean;
  path: string | null;
}

export async function checkPrerequisites(): Promise<Prerequisite[]> {
  return invoke<Prerequisite[]>("check_prerequisites");
}

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export async function getMarketingstackDir(): Promise<string> {
  return invoke<string>("get_marketingstack_dir");
}

export async function ensureMarketingstackDir(): Promise<string> {
  return invoke<string>("ensure_marketingstack_dir");
}

export interface DevServerHandle {
  pty: IPty;
  stop: () => Promise<void>;
}

export async function startDevServer(
  projectPath: string,
  onOutput?: (data: string) => void
): Promise<DevServerHandle> {
  const decoder = new TextDecoder();

  const pty = await spawn("npm", ["run", "dev"], {
    cwd: projectPath,
    cols: 80,
    rows: 24,
  });

  if (onOutput) {
    pty.onData((data) => {
      onOutput(decoder.decode(data));
    });
  }

  return {
    pty,
    stop: async () => {
      try {
        pty.kill();
      } catch {
        // Ignore errors
      }
    },
  };
}

export async function waitForServer(
  url: string,
  maxAttempts = 30,
  intervalMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(url, { mode: "no-cors" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}
