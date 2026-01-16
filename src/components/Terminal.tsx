import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  projectPath: string;
  onExit?: (code: number | null) => void;
}

export function Terminal({ projectPath, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const [isReady, setIsReady] = useState(false);

  const cleanup = useCallback(async () => {
    for (const unlisten of unlistenersRef.current) {
      unlisten();
    }
    unlistenersRef.current = [];

    if (ptyIdRef.current !== null) {
      try {
        await invoke("kill_pty", { id: ptyIdRef.current });
      } catch {
        // Ignore
      }
      ptyIdRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }
  }, []);

  // Initialize terminal after mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Wait for container to have dimensions
    const checkReady = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setIsReady(true);
      } else {
        requestAnimationFrame(checkReady);
      }
    };
    checkReady();
  }, []);

  // Create terminal when ready
  useEffect(() => {
    if (!isReady || !containerRef.current) return;

    const container = containerRef.current;

    // Create terminal with Nerd Font for proper glyph rendering
    const term = new XTerm({
      fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#3a3d41",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    // Open terminal in container
    term.open(container);

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Setup PTY connection
    const setupPty = async () => {
      try {
        // Fit again to ensure correct size
        fitAddon.fit();

        // Listen for output
        const unlistenOutput = await listen<{ id: number; data: string }>(
          "pty-output",
          (event) => {
            if (event.payload.id === ptyIdRef.current && terminalRef.current) {
              terminalRef.current.write(event.payload.data);
            }
          }
        );
        unlistenersRef.current.push(unlistenOutput);

        // Listen for exit
        const unlistenExit = await listen<{ id: number; code: number | null }>(
          "pty-exit",
          (event) => {
            if (event.payload.id === ptyIdRef.current) {
              terminalRef.current?.write("\r\n[Process exited]\r\n");
              onExit?.(event.payload.code);
            }
          }
        );
        unlistenersRef.current.push(unlistenExit);

        // Spawn PTY
        const id = await invoke<number>("spawn_pty", {
          cwd: projectPath,
          command: "claude",
          rows: term.rows,
          cols: term.cols,
        });
        ptyIdRef.current = id;

        // Handle input
        term.onData((data) => {
          if (ptyIdRef.current !== null) {
            invoke("write_pty", { id: ptyIdRef.current, data });
          }
        });

      } catch (err) {
        term.write(`\x1b[31mError: ${err}\x1b[0m\r\n`);
      }
    };

    setupPty();

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current && ptyIdRef.current !== null) {
        fitAddonRef.current.fit();
        invoke("resize_pty", {
          id: ptyIdRef.current,
          rows: terminalRef.current.rows,
          cols: terminalRef.current.cols,
        });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      cleanup();
    };
  }, [isReady, projectPath, onExit, cleanup]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e1e",
      }}
    />
  );
}
