/**
 * Main onboarding screen that orchestrates the setup flow.
 *
 * Handles:
 * - Fetching and displaying setup status
 * - Triggering installations and authentications
 * - Embedded terminal for interactive CLI commands
 * - Transitioning to celebration screen when complete
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { SetupChecklist } from './SetupChecklist';
import { CelebrationScreen } from './CelebrationScreen';
import { OnboardingTerminal } from './OnboardingTerminal';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  checkClaudeAuthStatus,
  installBrewPackages,
  BREW_PACKAGES,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  SETUP_FRIENDLY_NAMES,
  OPTIONAL_ITEMS,
} from '../../lib/setup';
import { checkGitHubCliStatus } from '../../lib/github';
import { checkVercelCliStatus } from '../../lib/vercel';
import { openUrl } from '@tauri-apps/plugin-opener';
import { SlackIcon } from '../icons';

type OnboardingState = 'loading' | 'setup' | 'complete';

/** Configuration for the active terminal command */
interface TerminalConfig {
  itemId: string;
  command: string;
  args: string[];
}

interface OnboardingScreenProps {
  /** Called when setup is complete and user continues */
  onComplete: () => void;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [state, setState] = useState<OnboardingState>('loading');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalConfig, setTerminalConfig] = useState<TerminalConfig | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // Fetch initial status
  const fetchStatus = useCallback(async () => {
    try {
      const status: FullSetupStatus = await getFullSetupStatus();
      setItems(status.items);
      if (status.allReady) {
        setState('complete');
      } else {
        setState('setup');
      }
      setError(null);
    } catch (err) {
      console.warn('Failed to fetch setup status:', err);
      setError('Failed to check setup status. Please try again.');
      setState('setup');
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    // Intentionally not awaited - fire-and-forget on mount
    // eslint-disable-next-line @typescript-eslint/no-floating-promises, react-hooks/set-state-in-effect
    fetchStatus();
  }, [fetchStatus]);

  // Listen for setup progress events
  useEffect(() => {
    const setupListener = async () => {
      unlistenRef.current = await listen<{ itemId: string; message: string }>(
        'setup-progress',
        (event) => {
          console.warn('Setup progress:', event.payload);
        }
      );
    };
    void setupListener();
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  // Update a single item's status
  const updateItemStatus = useCallback((itemId: string, updates: Partial<SetupItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item)));
  }, []);

  // Handle terminal exit - process exit codes and check auth status
  const handleTerminalExit = useCallback(
    async (exitCode: number | null) => {
      const itemId = terminalConfig?.itemId;
      if (!itemId) return;

      // Hide terminal
      setTerminalConfig(null);

      if (exitCode === 0 || exitCode === null) {
        // Success (or process ended without explicit code) - refresh status
        // Success - for auth items, verify the auth status
        if (itemId === 'gh_auth') {
          const status = await checkGitHubCliStatus();
          if (!status.authenticated) {
            updateItemStatus(itemId, {
              status: 'error',
              errorMessage: 'Authentication not completed. Click to try again.',
            });
            setActiveItemId(null);
            return;
          }
        } else if (itemId === 'claude_auth') {
          const isAuthed = await checkClaudeAuthStatus();
          if (!isAuthed) {
            updateItemStatus(itemId, {
              status: 'error',
              errorMessage: 'Authentication not completed. Click to try again.',
            });
            setActiveItemId(null);
            return;
          }
        } else if (itemId === 'vercel_auth') {
          const status = await checkVercelCliStatus();
          if (!status.authenticated) {
            updateItemStatus(itemId, {
              status: 'error',
              errorMessage: 'Authentication not completed. Click to try again.',
            });
            setActiveItemId(null);
            return;
          }
        }

        // Refresh full status
        await fetchStatus();
      } else {
        // Non-zero exit code - show error
        updateItemStatus(itemId, {
          status: 'error',
          errorMessage: 'Command failed. Click to try again.',
        });
      }

      setActiveItemId(null);
    },
    [terminalConfig, fetchStatus, updateItemStatus]
  );

  // Handle terminal cancel
  const handleTerminalCancel = useCallback(() => {
    const itemId = terminalConfig?.itemId;
    if (itemId) {
      // Reset item status back to what it was
      void fetchStatus();
    }
    setTerminalConfig(null);
    setActiveItemId(null);
  }, [terminalConfig, fetchStatus]);

  // Handle item action (install or connect)
  const handleItemAction = useCallback(
    async (itemId: string) => {
      if (activeItemId || terminalConfig) return; // Already processing something

      setActiveItemId(itemId);
      updateItemStatus(itemId, { status: 'in_progress', errorMessage: undefined });

      // Check if this item uses terminal
      if (USES_TERMINAL.has(itemId)) {
        const cmd = TERMINAL_COMMANDS[itemId];
        if (cmd) {
          setTerminalConfig({
            itemId,
            command: cmd.command,
            args: cmd.args,
          });
          return; // Terminal will handle the rest
        }
      }

      // Non-terminal items - run via backend
      try {
        // Check if this is a brew package - if so, batch install all missing brew packages
        if (BREW_PACKAGES.has(itemId)) {
          // Find all missing brew packages to install in one command
          const missingBrewPackages = items
            .filter((item) => BREW_PACKAGES.has(item.id) && item.status !== 'ready')
            .map((item) => item.id);

          // Mark all of them as in_progress
          for (const pkgId of missingBrewPackages) {
            if (pkgId !== itemId) {
              updateItemStatus(pkgId, { status: 'in_progress', errorMessage: undefined });
            }
          }

          // Batch install all missing brew packages
          await installBrewPackages(missingBrewPackages);
        } else {
          console.warn('Unknown item:', itemId);
        }

        // Installation complete, refresh status
        await fetchStatus();
        setActiveItemId(null);
      } catch (err) {
        console.warn(`Failed to process ${itemId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Show the actual error message so users can troubleshoot
        // Strip error codes like [VERCEL_INSTALL_002] for cleaner display
        const cleanedMessage = errorMessage.replace(/\[[\w_]+\]\s*/g, '').trim();

        // If this was a batch brew install, reset all in_progress brew items
        if (BREW_PACKAGES.has(itemId)) {
          for (const item of items) {
            if (BREW_PACKAGES.has(item.id) && item.status === 'in_progress') {
              updateItemStatus(item.id, {
                status: 'error',
                errorMessage: cleanedMessage || 'Something went wrong. Click to try again.',
              });
            }
          }
        } else {
          updateItemStatus(itemId, {
            status: 'error',
            errorMessage: cleanedMessage || 'Something went wrong. Click to try again.',
          });
        }
        setActiveItemId(null);
      }
    },
    [activeItemId, terminalConfig, updateItemStatus, fetchStatus, items]
  );

  // Check if all required items are ready (optional items can be skipped)
  useEffect(() => {
    if (items.length > 0) {
      const requiredItems = items.filter((item) => !OPTIONAL_ITEMS.has(item.id));
      if (requiredItems.every((item) => item.status === 'ready')) {
        // Valid pattern: conditional state update based on derived state
        // This is a computed state transition, not a cascading render
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState('complete');
      }
    }
  }, [items]);

  // Handle skipping an optional item - check if we can proceed
  const handleItemSkip = useCallback(() => {
    // Refresh status to check if required items are ready
    void fetchStatus();
  }, [fetchStatus]);

  if (state === 'loading') {
    return (
      <div className="onboarding-screen onboarding-loading">
        <div className="spinner" />
        <p>Checking setup status...</p>
      </div>
    );
  }

  if (state === 'complete') {
    return <CelebrationScreen onContinue={onComplete} />;
  }

  // Calculate progress (only count required items)
  const requiredItems = items.filter((item) => !OPTIONAL_ITEMS.has(item.id));
  const readyCount = requiredItems.filter((item) => item.status === 'ready').length;
  const totalCount = requiredItems.length;

  return (
    <div className="onboarding-screen">
      <div className="onboarding-content">
        <div className="onboarding-header">
          <img src="/ship_studio_full_noshadow.svg" alt="Ship Studio" className="onboarding-logo" />
          <h1>Quick Setup</h1>
          <p className="onboarding-reassurance">
            Most users finish in under 3 minutes. Let's get you ready to ship.
          </p>
        </div>

        {error && (
          <div className="onboarding-error">
            <p>{error}</p>
            <button className="btn-secondary" onClick={() => void fetchStatus()}>
              Retry
            </button>
          </div>
        )}

        <SetupChecklist
          items={items}
          onItemAction={(itemId) => void handleItemAction(itemId)}
          onItemSkip={handleItemSkip}
          activeItemId={activeItemId}
          terminalActive={terminalConfig !== null}
        />

        {/* Terminal modal for interactive commands */}
        {terminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">
                  {SETUP_FRIENDLY_NAMES[terminalConfig.itemId] || terminalConfig.itemId}
                </span>
                <button className="onboarding-terminal-cancel" onClick={handleTerminalCancel}>
                  Cancel
                </button>
              </div>
              <OnboardingTerminal
                command={terminalConfig.command}
                args={terminalConfig.args}
                onExit={(exitCode) => void handleTerminalExit(exitCode)}
              />
            </div>
          </div>
        )}

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

        <div className="onboarding-slack-cta">
          <SlackIcon size={18} />
          <span>
            <strong>Having problems getting set up?</strong> Join the Slack channel and we'll help
            you out!
          </span>
          <button
            onClick={() =>
              void openUrl(
                'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-3ommmu2w4-jtYZzzc9T~9lsEeKQ4E2AQ'
              )
            }
          >
            Join Slack
          </button>
        </div>
      </div>
    </div>
  );
}
