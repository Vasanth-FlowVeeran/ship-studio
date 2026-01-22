/**
 * Main onboarding screen that orchestrates the setup flow.
 *
 * Handles:
 * - Fetching and displaying setup status
 * - Triggering installations and authentications
 * - Polling for auth completion
 * - Transitioning to celebration screen when complete
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { SetupChecklist } from "./SetupChecklist";
import { CelebrationScreen } from "./CelebrationScreen";
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  installHomebrew,
  installNode,
  installGit,
  installGh,
  startGitHubAuth,
  installClaude,
  startClaudeAuth,
  checkClaudeAuthStatus,
  installVercel,
  startVercelAuth,
} from "../../lib/setup";
import { checkGitHubCliStatus } from "../../lib/github";
import { checkVercelCliStatus } from "../../lib/vercel";

type OnboardingState = "loading" | "setup" | "complete";

interface OnboardingScreenProps {
  /** Called when setup is complete and user continues */
  onComplete: () => void;
}

/** Auth polling interval in ms */
const AUTH_POLL_INTERVAL = 2000;
/** Auth timeout in ms (3 minutes) */
const AUTH_TIMEOUT = 180000;

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [state, setState] = useState<OnboardingState>("loading");
  const [items, setItems] = useState<SetupItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track polling timers for cleanup
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup function for polling
  const cleanupPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupPolling();
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, [cleanupPolling]);

  // Fetch initial status
  const fetchStatus = useCallback(async () => {
    try {
      const status: FullSetupStatus = await getFullSetupStatus();
      setItems(status.items);
      if (status.allReady) {
        setState("complete");
      } else {
        setState("setup");
      }
      setError(null);
    } catch (err) {
      console.error("Failed to fetch setup status:", err);
      setError("Failed to check setup status. Please try again.");
      setState("setup");
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Listen for setup progress events
  useEffect(() => {
    const setupListener = async () => {
      unlistenRef.current = await listen<{ itemId: string; message: string }>(
        "setup-progress",
        (event) => {
          console.log("Setup progress:", event.payload);
        }
      );
    };
    setupListener();
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // Update a single item's status
  const updateItemStatus = useCallback(
    (
      itemId: string,
      updates: Partial<SetupItem>
    ) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId ? { ...item, ...updates } : item
        )
      );
    },
    []
  );

  // Handle GitHub auth polling
  const pollGitHubAuth = useCallback(async () => {
    const startTime = Date.now();

    pollTimerRef.current = setInterval(async () => {
      try {
        const status = await checkGitHubCliStatus();
        if (status.authenticated) {
          cleanupPolling();
          // Refresh full status to get username
          await fetchStatus();
          setActiveItemId(null);
        } else if (Date.now() - startTime > AUTH_TIMEOUT) {
          cleanupPolling();
          updateItemStatus("gh_auth", {
            status: "error",
            errorMessage: "Authentication timed out. Click to try again.",
          });
          setActiveItemId(null);
        }
      } catch (err) {
        console.error("GitHub auth poll error:", err);
      }
    }, AUTH_POLL_INTERVAL);

    // Set timeout
    timeoutRef.current = setTimeout(() => {
      cleanupPolling();
      updateItemStatus("gh_auth", {
        status: "error",
        errorMessage: "Authentication timed out. Click to try again.",
      });
      setActiveItemId(null);
    }, AUTH_TIMEOUT);
  }, [cleanupPolling, fetchStatus, updateItemStatus]);

  // Handle Claude auth polling
  const pollClaudeAuth = useCallback(async () => {
    const startTime = Date.now();

    pollTimerRef.current = setInterval(async () => {
      try {
        const isAuthed = await checkClaudeAuthStatus();
        if (isAuthed) {
          cleanupPolling();
          await fetchStatus();
          setActiveItemId(null);
        } else if (Date.now() - startTime > AUTH_TIMEOUT) {
          cleanupPolling();
          updateItemStatus("claude_auth", {
            status: "error",
            errorMessage: "Authentication timed out. Click to try again.",
          });
          setActiveItemId(null);
        }
      } catch (err) {
        console.error("Claude auth poll error:", err);
      }
    }, AUTH_POLL_INTERVAL);

    timeoutRef.current = setTimeout(() => {
      cleanupPolling();
      updateItemStatus("claude_auth", {
        status: "error",
        errorMessage: "Authentication timed out. Click to try again.",
      });
      setActiveItemId(null);
    }, AUTH_TIMEOUT);
  }, [cleanupPolling, fetchStatus, updateItemStatus]);

  // Handle Vercel auth polling
  const pollVercelAuth = useCallback(async () => {
    const startTime = Date.now();

    pollTimerRef.current = setInterval(async () => {
      try {
        const status = await checkVercelCliStatus();
        if (status.authenticated) {
          cleanupPolling();
          await fetchStatus();
          setActiveItemId(null);
        } else if (Date.now() - startTime > AUTH_TIMEOUT) {
          cleanupPolling();
          updateItemStatus("vercel_auth", {
            status: "error",
            errorMessage: "Authentication timed out. Click to try again.",
          });
          setActiveItemId(null);
        }
      } catch (err) {
        console.error("Vercel auth poll error:", err);
      }
    }, AUTH_POLL_INTERVAL);

    timeoutRef.current = setTimeout(() => {
      cleanupPolling();
      updateItemStatus("vercel_auth", {
        status: "error",
        errorMessage: "Authentication timed out. Click to try again.",
      });
      setActiveItemId(null);
    }, AUTH_TIMEOUT);
  }, [cleanupPolling, fetchStatus, updateItemStatus]);

  // Handle item action (install or connect)
  const handleItemAction = useCallback(
    async (itemId: string) => {
      if (activeItemId) return; // Already processing something

      setActiveItemId(itemId);
      updateItemStatus(itemId, { status: "in_progress", errorMessage: undefined });

      try {
        switch (itemId) {
          case "homebrew":
            await installHomebrew();
            break;
          case "node":
            await installNode();
            break;
          case "git":
            await installGit();
            break;
          case "gh":
            await installGh();
            break;
          case "gh_auth":
            await startGitHubAuth();
            // Start polling for auth completion
            pollGitHubAuth();
            return; // Don't refresh yet, polling will handle it
          case "claude":
            await installClaude();
            break;
          case "claude_auth":
            await startClaudeAuth();
            pollClaudeAuth();
            return; // Polling will handle it
          case "vercel":
            await installVercel();
            break;
          case "vercel_auth":
            await startVercelAuth();
            pollVercelAuth();
            return; // Polling will handle it
          default:
            console.warn("Unknown item:", itemId);
        }

        // Installation complete, refresh status
        await fetchStatus();
        setActiveItemId(null);
      } catch (err) {
        console.error(`Failed to process ${itemId}:`, err);
        const errorMessage =
          err instanceof Error ? err.message : "Something went wrong";
        updateItemStatus(itemId, {
          status: "error",
          errorMessage: errorMessage.includes("internet")
            ? "Connection failed. Check your internet and try again."
            : "Something went wrong. Click to try again.",
        });
        setActiveItemId(null);
      }
    },
    [
      activeItemId,
      updateItemStatus,
      fetchStatus,
      pollGitHubAuth,
      pollClaudeAuth,
      pollVercelAuth,
    ]
  );

  // Check if all items are ready
  useEffect(() => {
    if (items.length > 0 && items.every((item) => item.status === "ready")) {
      setState("complete");
    }
  }, [items]);

  if (state === "loading") {
    return (
      <div className="onboarding-screen onboarding-loading">
        <div className="spinner" />
        <p>Checking setup status...</p>
      </div>
    );
  }

  if (state === "complete") {
    return <CelebrationScreen onContinue={onComplete} />;
  }

  // Calculate progress
  const readyCount = items.filter((item) => item.status === "ready").length;
  const totalCount = items.length;

  return (
    <div className="onboarding-screen">
      <div className="onboarding-content">
        <div className="onboarding-header">
          <h1>Welcome to Marketingstack</h1>
          <p>Let's get your development environment set up</p>
        </div>

        {error && (
          <div className="onboarding-error">
            <p>{error}</p>
            <button className="btn-secondary" onClick={fetchStatus}>
              Retry
            </button>
          </div>
        )}

        <SetupChecklist
          items={items}
          onItemAction={handleItemAction}
          activeItemId={activeItemId}
        />

        <div className="onboarding-progress">
          <div className="onboarding-progress-bar">
            <div
              className="onboarding-progress-fill"
              style={{ width: `${(readyCount / totalCount) * 100}%` }}
            />
          </div>
          <span className="onboarding-progress-text">
            {readyCount} of {totalCount} ready
          </span>
        </div>
      </div>
    </div>
  );
}
