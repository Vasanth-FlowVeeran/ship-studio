import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { CanvasAddon } from "@xterm/addon-canvas";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  projectPath: string;
  onExit?: (code: number | null) => void;
}

export function Terminal({ projectPath, onExit }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);

  const cleanup = useCallback(async () => {
    if (unlistenOutputRef.current) {
      unlistenOutputRef.current();
      unlistenOutputRef.current = null;
    }
    if (unlistenExitRef.current) {
      unlistenExitRef.current();
      unlistenExitRef.current = null;
    }
    if (ptyIdRef.current !== null) {
      try {
        await invoke("kill_pty", { id: ptyIdRef.current });
      } catch {
        // Ignore errors when killing PTY
      }
      ptyIdRef.current = null;
    }
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", "Lucida Console", "Apple Color Emoji", "Segoe UI Emoji", monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      fontWeight: "normal",
      fontWeightBold: "bold",
      theme: {
        background: "#1a1a2e",
        foreground: "#eaeaea",
        cursor: "#eaeaea",
        cursorAccent: "#1a1a2e",
        selectionBackground: "#3d3d5c",
        black: "#1a1a2e",
        red: "#ff6b6b",
        green: "#4ecdc4",
        yellow: "#ffe66d",
        blue: "#4dabf7",
        magenta: "#da77f2",
        cyan: "#63e6be",
        white: "#eaeaea",
        brightBlack: "#6c6c8a",
        brightRed: "#ff8787",
        brightGreen: "#69db7c",
        brightYellow: "#fff3bf",
        brightBlue: "#74c0fc",
        brightMagenta: "#e599f7",
        brightCyan: "#96f2d7",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();
    const canvasAddon = new CanvasAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.open(termRef.current);

    // Load canvas addon after opening for better rendering
    try {
      term.loadAddon(canvasAddon);
    } catch (e) {
      console.warn("Canvas addon failed to load:", e);
    }

    // Enable unicode11 for better box-drawing character support
    term.unicode.activeVersion = "11";

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Set up PTY after terminal is ready
    const setupPty = async () => {
      try {
        // Wait for next frame to ensure terminal is properly sized
        await new Promise((resolve) => requestAnimationFrame(resolve));

        // Fit the terminal
        fitAddon.fit();

        // Small delay to ensure size is stable
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Fit again to be sure
        fitAddon.fit();

        const rows = term.rows;
        const cols = term.cols;

        // Listen for PTY output
        unlistenOutputRef.current = await listen<{ id: number; data: string }>(
          "pty-output",
          (event) => {
            if (event.payload.id === ptyIdRef.current) {
              term.write(event.payload.data);
            }
          }
        );

        // Listen for PTY exit
        unlistenExitRef.current = await listen<{
          id: number;
          code: number | null;
        }>("pty-exit", (event) => {
          if (event.payload.id === ptyIdRef.current) {
            term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
            onExit?.(event.payload.code);
          }
        });

        // Spawn Claude in the project directory
        const id = await invoke<number>("spawn_pty", {
          cwd: projectPath,
          command: "claude",
          rows,
          cols,
        });

        ptyIdRef.current = id;

        // Handle user input
        term.onData((data) => {
          if (ptyIdRef.current !== null) {
            invoke("write_pty", { id: ptyIdRef.current, data }).catch(
              console.error
            );
          }
        });
      } catch (error) {
        term.write(`\x1b[31mError: ${error}\x1b[0m\r\n`);
        term.write("\x1b[90mMake sure Claude Code is installed and in your PATH.\x1b[0m\r\n");
      }
    };

    setupPty();

    // Handle resize with debounce
    let resizeTimeout: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = window.setTimeout(() => {
        fitAddon.fit();
        if (ptyIdRef.current !== null) {
          invoke("resize_pty", {
            id: ptyIdRef.current,
            rows: term.rows,
            cols: term.cols,
          }).catch(console.error);
        }
      }, 50);
    });
    resizeObserver.observe(termRef.current);

    return () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeObserver.disconnect();
      cleanup();
    };
  }, [projectPath, onExit, cleanup]);

  return (
    <div
      ref={termRef}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1a2e",
        overflow: "hidden",
      }}
    />
  );
}
