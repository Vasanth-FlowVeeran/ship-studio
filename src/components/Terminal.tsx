import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { spawn, IPty } from "tauri-pty";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  projectPath: string;
  onExit?: (code: number | null) => void;
}

export interface TerminalHandle {
  focus: () => void;
  write: (data: string) => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ projectPath, onExit }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<IPty | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Use ref for onExit to prevent effect re-runs when callback reference changes
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  const cleanup = useCallback(() => {
    if (ptyRef.current) {
      try {
        ptyRef.current.kill();
      } catch {
        // Ignore
      }
      ptyRef.current = null;
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

  // Listen for Tauri file drop events
  // Use a ref for debounce to persist across HMR
  const lastDropTimeRef = useRef(0);
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupDropListener = async () => {
      // Listen for the tauri://drag-drop event
      unlisten = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        "tauri://drag-drop",
        async (event) => {
          // Debounce - ignore duplicate events within 500ms
          const now = Date.now();
          if (now - lastDropTimeRef.current < 500) {
            return;
          }
          lastDropTimeRef.current = now;

          const pty = ptyRef.current;
          const term = terminalRef.current;

          if (pty && term && event.payload.paths && event.payload.paths.length > 0) {
            // Quote paths that contain spaces
            const quotedPaths = event.payload.paths.map(p =>
              p.includes(" ") ? `"${p}"` : p
            ).join(" ");

            // Focus terminal and paste the path
            term.focus();
            (term as any).paste(quotedPaths);
          }
        }
      );
    };

    setupDropListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
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

    // Setup PTY connection using tauri-pty with retry logic
    const setupPty = async (retryCount = 0) => {
      const maxRetries = 3;

      try {
        // Fit again to ensure correct size
        fitAddon.fit();

        // Spawn PTY using tauri-pty
        const pty = await spawn("claude", [], {
          cwd: projectPath,
          cols: term.cols,
          rows: term.rows,
        });

        ptyRef.current = pty;

        // Handle PTY output -> terminal
        pty.onData((data) => {
          terminalRef.current?.write(data);
        });

        // Handle PTY exit
        pty.onExit(({ exitCode }) => {
          terminalRef.current?.write("\r\n[Process exited]\r\n");
          onExitRef.current?.(exitCode);
        });

        // Handle terminal input -> PTY
        term.onData((data) => {
          ptyRef.current?.write(data);
        });

      } catch (err) {
        console.error("Failed to spawn Claude:", err);

        if (retryCount < maxRetries) {
          term.write(`\x1b[33mFailed to start Claude, retrying (${retryCount + 1}/${maxRetries})...\x1b[0m\r\n`);
          setTimeout(() => setupPty(retryCount + 1), 1000);
        } else {
          term.write(`\x1b[31mError starting Claude: ${err}\x1b[0m\r\n`);
          term.write(`\x1b[33mMake sure Claude Code is installed: npm install -g @anthropic-ai/claude-code\x1b[0m\r\n`);
        }
      }
    };

    // Small delay before starting to ensure terminal is ready
    setTimeout(() => setupPty(), 100);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
        fitAddonRef.current.fit();
        ptyRef.current.resize(terminalRef.current.cols, terminalRef.current.rows);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      cleanup();
    };
  }, [isReady, projectPath, cleanup]);

  // Click to focus terminal
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Handle drag over to allow drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Handle file drop - write file path to terminal (fallback for React drag events)
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Main drop handling is done via Tauri's drag-drop event listener
  }, []);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      terminalRef.current?.focus();
      containerRef.current?.focus();
      const textarea = containerRef.current?.querySelector('textarea');
      textarea?.focus();
    },
    write: (data: string) => {
      ptyRef.current?.write(data);
    },
  }), []);

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e1e",
      }}
    />
  );
});
