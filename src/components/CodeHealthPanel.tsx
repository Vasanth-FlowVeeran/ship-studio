/**
 * CodeHealthPanel component for running code quality checks.
 *
 * Provides a collapsible panel with buttons to run:
 * - Tests (npm test, vitest, jest, etc.)
 * - Linting (eslint, lint, etc.)
 * - Type checking (tsc, typecheck, etc.)
 * - Format checking (prettier, format, etc.)
 *
 * Displays visual pass/fail indicators and persists results between sessions.
 *
 * @module components/CodeHealthPanel
 */

import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import {
  DetectedScripts,
  HealthCheckResult,
  ScriptCategory,
  ScriptSuggestion,
  detectHealthScripts,
  runHealthScript,
  getHealthStatus,
  getPackageJson,
  formatRelativeTime,
  formatDuration,
  getFixPrompt,
} from '../lib/health';
import { logger } from '../lib/logger';
import { ChevronIcon, ChevronRightIcon, SpinnerIcon, CloseIcon, CopyIcon, FileIcon } from './icons';

interface CodeHealthPanelProps {
  projectPath: string;
  onToast?: (message: string, type?: 'success' | 'error') => void;
  onAskClaude?: (prompt: string) => void;
  onHealthOutput?: (output: string) => void;
  /** Content to render on the left of the toolbar (e.g., Restart Server button) */
  toolbarLeft?: React.ReactNode;
  /** Content to render on the right of the toolbar (e.g., Show Preview button) */
  toolbarRight?: React.ReactNode;
}

export interface CodeHealthPanelRef {
  runAllChecks: () => Promise<void>;
  refreshScripts: () => Promise<void>;
}

type CheckStatus = 'idle' | 'running' | 'pass' | 'fail' | 'missing';

interface CheckState {
  status: CheckStatus;
  result: HealthCheckResult | null;
  scriptName: string | null;
}

const CATEGORIES: ScriptCategory[] = ['test', 'lint', 'typecheck', 'format'];
const CATEGORY_LABELS: Record<ScriptCategory, string> = {
  test: 'Test',
  lint: 'Lint',
  typecheck: 'Types',
  format: 'Format',
};

export const CodeHealthPanel = forwardRef<CodeHealthPanelRef, CodeHealthPanelProps>(
  function CodeHealthPanel(
    { projectPath, onToast, onAskClaude, onHealthOutput, toolbarLeft, toolbarRight },
    ref
  ) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [detectedScripts, setDetectedScripts] = useState<DetectedScripts | null>(null);
    const [checkStates, setCheckStates] = useState<Record<ScriptCategory, CheckState>>({
      test: { status: 'idle', result: null, scriptName: null },
      lint: { status: 'idle', result: null, scriptName: null },
      typecheck: { status: 'idle', result: null, scriptName: null },
      format: { status: 'idle', result: null, scriptName: null },
    });
    const [errorModalCategory, setErrorModalCategory] = useState<ScriptCategory | null>(null);
    const [isRunningAll, setIsRunningAll] = useState(false);
    const runAllAbortRef = useRef(false);
    const [showPackageJson, setShowPackageJson] = useState(false);
    const [packageJsonContent, setPackageJsonContent] = useState<string | null>(null);
    const [isLoadingPackageJson, setIsLoadingPackageJson] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    // Auto-run state
    const AUTO_RUN_INTERVAL_SECONDS = 15 * 60; // 15 minutes
    const [isAutoRunEnabled, setIsAutoRunEnabled] = useState(false);
    const [autoRunSecondsRemaining, setAutoRunSecondsRemaining] =
      useState(AUTO_RUN_INTERVAL_SECONDS);
    const autoRunIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Helper to emit output to logs
    const emitOutput = useCallback(
      (message: string) => {
        if (onHealthOutput) {
          onHealthOutput(message);
        }
      },
      [onHealthOutput]
    );

    // Function to load/refresh scripts and status
    const loadScriptsAndStatus = useCallback(async () => {
      if (!projectPath) return;

      try {
        // Detect available scripts
        const scripts = await detectHealthScripts(projectPath);
        setDetectedScripts(scripts);

        // Initialize check states based on detected scripts
        const newStates: Record<ScriptCategory, CheckState> = {
          test: {
            status: scripts.test ? 'idle' : 'missing',
            result: null,
            scriptName: scripts.test,
          },
          lint: {
            status: scripts.lint ? 'idle' : 'missing',
            result: null,
            scriptName: scripts.lint,
          },
          typecheck: {
            status: scripts.typecheck ? 'idle' : 'missing',
            result: null,
            scriptName: scripts.typecheck,
          },
          format: {
            status: scripts.format ? 'idle' : 'missing',
            result: null,
            scriptName: scripts.format,
          },
        };

        // Load persisted status
        const savedStatus = await getHealthStatus(projectPath);
        if (savedStatus) {
          for (const category of CATEGORIES) {
            const result = savedStatus[category];
            if (result && newStates[category].scriptName) {
              newStates[category].status = result.status === 'pass' ? 'pass' : 'fail';
              newStates[category].result = result;
            }
          }
        }

        setCheckStates(newStates);
      } catch (e) {
        logger.error('Failed to detect health scripts', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, [projectPath]);

    // Detect scripts on mount and when project changes
    useEffect(() => {
      void loadScriptsAndStatus();
    }, [loadScriptsAndStatus]);

    // Refresh scripts (called after Claude modifies package.json)
    const handleRefresh = useCallback(async () => {
      setIsRefreshing(true);
      await loadScriptsAndStatus();
      setIsRefreshing(false);
      onToast?.('Scripts refreshed', 'success');
    }, [loadScriptsAndStatus, onToast]);

    const runCheck = useCallback(
      async (category: ScriptCategory): Promise<'pass' | 'fail' | undefined> => {
        const scriptName = checkStates[category].scriptName;
        if (!scriptName || !projectPath) return undefined;

        // Set running state
        setCheckStates((prev) => ({
          ...prev,
          [category]: { ...prev[category], status: 'running' },
        }));

        // Emit start message to logs
        const timestamp = new Date().toLocaleTimeString();
        emitOutput(
          `\x1b[90m[${timestamp}]\x1b[0m Running \x1b[36m${CATEGORY_LABELS[category]}\x1b[0m check (${scriptName})...\r\n`
        );

        try {
          const result = await runHealthScript(projectPath, category, scriptName);

          setCheckStates((prev) => ({
            ...prev,
            [category]: {
              ...prev[category],
              status: result.status === 'pass' ? 'pass' : 'fail',
              result,
            },
          }));

          // Emit result to logs
          const duration = formatDuration(result.durationMs);
          if (result.status === 'pass') {
            emitOutput(
              `\x1b[32m✓\x1b[0m ${CATEGORY_LABELS[category]} passed \x1b[90m(${duration})\x1b[0m\r\n`
            );
            onToast?.(`${CATEGORY_LABELS[category]} passed`, 'success');
            return 'pass';
          } else {
            emitOutput(
              `\x1b[31m✕\x1b[0m ${CATEGORY_LABELS[category]} failed \x1b[90m(${duration})\x1b[0m\r\n`
            );
            // Emit output details
            const output = result.stdout || result.stderr;
            if (output) {
              emitOutput(`\x1b[90m───────────────────────────────────────\x1b[0m\r\n`);
              // Convert newlines to terminal newlines
              emitOutput(output.replace(/\n/g, '\r\n'));
              if (!output.endsWith('\n')) {
                emitOutput('\r\n');
              }
              emitOutput(`\x1b[90m───────────────────────────────────────\x1b[0m\r\n`);
            }
            onToast?.(`${CATEGORY_LABELS[category]} failed`, 'error');
            return 'fail';
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          emitOutput(`\x1b[31m✕\x1b[0m ${CATEGORY_LABELS[category]} error: ${message}\r\n`);
          setCheckStates((prev) => ({
            ...prev,
            [category]: {
              ...prev[category],
              status: 'fail',
              result: {
                status: 'fail',
                lastRun: new Date().toISOString(),
                durationMs: 0,
                stdout: '',
                stderr: message,
                exitCode: 1,
                scriptName,
                category,
              },
            },
          }));
          onToast?.(`${CATEGORY_LABELS[category]} failed: ${message}`, 'error');
          return 'fail';
        }
      },
      [checkStates, projectPath, onToast, emitOutput]
    );

    const runAllChecks = useCallback(async () => {
      runAllAbortRef.current = false;
      setIsRunningAll(true);

      const availableCategories = CATEGORIES.filter(
        (cat) => checkStates[cat].scriptName && checkStates[cat].status !== 'missing'
      );

      if (availableCategories.length > 0) {
        emitOutput(`\r\n\x1b[1m━━━ Running All Health Checks ━━━\x1b[0m\r\n\r\n`);
      }

      // Track results locally to avoid stale state reads
      let localPassed = 0;
      let localFailed = 0;

      for (const category of availableCategories) {
        if (runAllAbortRef.current) break;
        const result = await runCheck(category);
        if (result === 'pass') {
          localPassed++;
        } else if (result === 'fail') {
          localFailed++;
        }
      }

      if (availableCategories.length > 0 && !runAllAbortRef.current) {
        emitOutput(`\r\n\x1b[1m━━━ Health Checks Complete ━━━\x1b[0m\r\n`);
        if (localFailed > 0) {
          emitOutput(`\x1b[31m${localFailed} failed\x1b[0m, ${localPassed} passed\r\n\r\n`);
        } else {
          emitOutput(`\x1b[32mAll ${localPassed} checks passed\x1b[0m\r\n\r\n`);
        }
      }

      setIsRunningAll(false);
    }, [checkStates, runCheck, emitOutput]);

    // Expose methods via ref for parent component
    useImperativeHandle(
      ref,
      () => ({
        runAllChecks,
        refreshScripts: loadScriptsAndStatus,
      }),
      [runAllChecks, loadScriptsAndStatus]
    );

    // Auto-run timer effect
    useEffect(() => {
      if (isAutoRunEnabled) {
        // Start countdown timer
        autoRunIntervalRef.current = setInterval(() => {
          setAutoRunSecondsRemaining((prev) => {
            if (prev <= 1) {
              // Time's up - run all checks and reset
              void runAllChecks();
              return AUTO_RUN_INTERVAL_SECONDS;
            }
            return prev - 1;
          });
        }, 1000);
      } else {
        // Clear timer and reset countdown
        if (autoRunIntervalRef.current) {
          clearInterval(autoRunIntervalRef.current);
          autoRunIntervalRef.current = null;
        }
        setAutoRunSecondsRemaining(AUTO_RUN_INTERVAL_SECONDS);
      }

      return () => {
        if (autoRunIntervalRef.current) {
          clearInterval(autoRunIntervalRef.current);
          autoRunIntervalRef.current = null;
        }
      };
    }, [isAutoRunEnabled, runAllChecks, AUTO_RUN_INTERVAL_SECONDS]);

    // Format seconds as MM:SS
    const formatCountdown = (seconds: number): string => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handleAutoRunToggle = () => {
      setIsAutoRunEnabled((prev) => !prev);
      if (!isAutoRunEnabled) {
        onToast?.('Auto-run enabled (every 15 min)', 'success');
      }
    };

    const handleButtonClick = (category: ScriptCategory) => {
      const state = checkStates[category];
      if (state.status === 'running' || state.status === 'missing') return;

      if (state.status === 'fail' && state.result) {
        // Show error modal
        setErrorModalCategory(category);
      } else {
        // Run the check
        void runCheck(category);
      }
    };

    const handleAskClaude = (category: ScriptCategory) => {
      const result = checkStates[category].result;
      if (!result) return;

      const prompt = `${getFixPrompt(category)}\n\n${result.stdout || result.stderr}`;
      onAskClaude?.(prompt);
      setErrorModalCategory(null);
    };

    const handleShowPackageJson = async () => {
      if (!projectPath) return;

      setIsLoadingPackageJson(true);
      try {
        const content = await getPackageJson(projectPath);
        setPackageJsonContent(content);
        setShowPackageJson(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        onToast?.(`Failed to load package.json: ${message}`, 'error');
      } finally {
        setIsLoadingPackageJson(false);
      }
    };

    // Check if health panel should show (has package.json with scripts)
    const hasAnyScripts = CATEGORIES.some((cat) => checkStates[cat].scriptName);
    const showHealthPanel = detectedScripts?.hasPackageJson && hasAnyScripts;

    // Count status summary for collapsed view
    const passingCount = CATEGORIES.filter((cat) => checkStates[cat].status === 'pass').length;
    const failingCount = CATEGORIES.filter((cat) => checkStates[cat].status === 'fail').length;
    const notRunCount = CATEGORIES.filter(
      (cat) => checkStates[cat].status === 'idle' && checkStates[cat].scriptName
    ).length;

    const isAnyRunning = CATEGORIES.some((cat) => checkStates[cat].status === 'running');

    return (
      <>
        {/* Main toolbar row with Restart Server, Health indicator, and preview actions */}
        <div className="terminal-toolbar">
          {toolbarLeft}
          {showHealthPanel && (
            <>
              <button
                className="health-toggle"
                onClick={() => setIsExpanded(!isExpanded)}
                title={isExpanded ? 'Collapse health panel' : 'Expand health panel'}
                data-education-id="health-panel"
              >
                {isExpanded ? <ChevronIcon size={10} /> : <ChevronRightIcon size={10} />}
                <span className="health-label">Health</span>
                <span className="health-summary">
                  {CATEGORIES.map((cat) => {
                    const state = checkStates[cat];
                    if (state.status === 'missing') return null;
                    return <StatusDot key={cat} status={state.status} size={6} />;
                  })}
                </span>
                {!isExpanded && (
                  <span className="health-collapsed-info">
                    {passingCount > 0 && (
                      <span className="health-count pass">{passingCount} passing</span>
                    )}
                    {failingCount > 0 && (
                      <span className="health-count fail">{failingCount} failing</span>
                    )}
                    {notRunCount > 0 && (
                      <span className="health-count idle">{notRunCount} not run</span>
                    )}
                  </span>
                )}
              </button>
              {isAutoRunEnabled && (
                <span className="health-countdown" title="Auto-run countdown">
                  <svg
                    width={10}
                    height={10}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>{formatCountdown(autoRunSecondsRemaining)}</span>
                </span>
              )}
            </>
          )}
          {toolbarRight}
        </div>

        {/* Expanded health toolbar row */}
        {showHealthPanel && isExpanded && (
          <div className="health-panel">
            <div className="health-buttons">
              {CATEGORIES.map((category) => {
                const state = checkStates[category];
                if (state.status === 'missing') return null;

                return (
                  <HealthButton
                    key={category}
                    label={CATEGORY_LABELS[category]}
                    state={state}
                    onClick={() => handleButtonClick(category)}
                    onRerun={() => void runCheck(category)}
                  />
                );
              })}

              <button
                className="health-run-all"
                onClick={() => void runAllChecks()}
                disabled={isAnyRunning || isRunningAll}
                title="Run all available checks"
              >
                {isRunningAll ? <SpinnerIcon size={12} /> : 'Run All'}
              </button>

              <button
                className={`health-auto-run ${isAutoRunEnabled ? 'active' : ''}`}
                onClick={handleAutoRunToggle}
                disabled={isRunningAll}
                title={
                  isAutoRunEnabled
                    ? `Auto-run in ${formatCountdown(autoRunSecondsRemaining)} (click to disable)`
                    : 'Enable auto-run every 15 minutes'
                }
              >
                {isAutoRunEnabled ? (
                  <>
                    <svg
                      width={10}
                      height={10}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>{formatCountdown(autoRunSecondsRemaining)}</span>
                  </>
                ) : (
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
              </button>

              <button
                className="health-pkg-json"
                onClick={() => void handleShowPackageJson()}
                disabled={isLoadingPackageJson}
                title="View package.json"
              >
                {isLoadingPackageJson ? <SpinnerIcon size={12} /> : <FileIcon size={12} />}
              </button>

              <button
                className="health-refresh"
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                title="Refresh scripts from package.json"
              >
                {isRefreshing ? (
                  <SpinnerIcon size={12} />
                ) : (
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                )}
              </button>

              {/* Suggestions indicator */}
              {detectedScripts?.suggestions && detectedScripts.suggestions.length > 0 && (
                <button
                  className="health-suggestions-btn"
                  onClick={() => setShowSuggestions(true)}
                  title={`${detectedScripts.suggestions.length} script suggestion${detectedScripts.suggestions.length > 1 ? 's' : ''} available`}
                >
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  <span>{detectedScripts.suggestions.length}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Error Modal */}
        {errorModalCategory && checkStates[errorModalCategory].result && (
          <HealthErrorModal
            category={errorModalCategory}
            result={checkStates[errorModalCategory].result}
            onClose={() => setErrorModalCategory(null)}
            onCopy={() => {
              const result = checkStates[errorModalCategory].result;
              if (result) {
                void navigator.clipboard.writeText(result.stdout || result.stderr);
                onToast?.('Output copied', 'success');
              }
            }}
            onAskClaude={() => handleAskClaude(errorModalCategory)}
            onRerun={() => {
              setErrorModalCategory(null);
              void runCheck(errorModalCategory);
            }}
          />
        )}

        {/* Package.json Modal */}
        {showPackageJson && packageJsonContent && (
          <PackageJsonModal
            content={packageJsonContent}
            onClose={() => setShowPackageJson(false)}
            onCopy={() => {
              void navigator.clipboard.writeText(packageJsonContent);
              onToast?.('package.json copied', 'success');
            }}
          />
        )}

        {/* Suggestions Modal */}
        {showSuggestions &&
          detectedScripts?.suggestions &&
          detectedScripts.suggestions.length > 0 && (
            <SuggestionsModal
              suggestions={detectedScripts.suggestions}
              onClose={() => setShowSuggestions(false)}
              onCopy={(text: string) => {
                void navigator.clipboard.writeText(text);
                onToast?.('Script copied to clipboard', 'success');
              }}
              onAskClaude={(suggestions: ScriptSuggestion[]) => {
                const scriptLines = suggestions
                  .map((s) => `"${s.scriptName}": "${s.scriptCommand}"`)
                  .join('\n    ');
                const prompt = `Please add the following scripts to my package.json file in the "scripts" section:\n\n    ${scriptLines}\n\nMake sure to preserve all existing scripts and formatting.`;
                onAskClaude?.(prompt);
                setShowSuggestions(false);
              }}
            />
          )}
      </>
    );
  }
);

// Status indicator dot/icon
function StatusDot({ status, size = 8 }: { status: CheckStatus; size?: number }) {
  switch (status) {
    case 'idle':
      return (
        <span className="status-dot idle" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
      );
    case 'running':
      return <SpinnerIcon size={size} className="status-dot running" />;
    case 'pass':
      return (
        <span className="status-dot pass" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="currentColor" />
          </svg>
        </span>
      );
    case 'fail':
      return (
        <span className="status-dot fail" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox="0 0 10 10">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="2" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
      );
    default:
      return null;
  }
}

// Individual health check button with tooltip
interface HealthButtonProps {
  label: string;
  state: CheckState;
  onClick: () => void;
  onRerun: () => void;
}

function HealthButton({ label, state, onClick, onRerun }: HealthButtonProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const tooltipContent = () => {
    if (!state.result) {
      return 'Never run';
    }
    return (
      <>
        <div>Last ran: {formatRelativeTime(state.result.lastRun)}</div>
        <div>Duration: {formatDuration(state.result.durationMs)}</div>
      </>
    );
  };

  return (
    <div
      className="health-button-wrapper"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        className={`health-button ${state.status}`}
        onClick={onClick}
        disabled={state.status === 'running'}
        title={state.status === 'fail' ? 'Click to view errors' : `Run ${label.toLowerCase()}`}
      >
        <StatusDot status={state.status} size={10} />
        <span>{label}</span>
      </button>

      {/* Re-run button for failed checks */}
      {state.status === 'fail' && (
        <button
          className="health-rerun"
          onClick={(e) => {
            e.stopPropagation();
            onRerun();
          }}
          title="Re-run check"
        >
          <svg
            width={10}
            height={10}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      )}

      {showTooltip && <div className="health-tooltip">{tooltipContent()}</div>}
    </div>
  );
}

// Error detail modal
interface HealthErrorModalProps {
  category: ScriptCategory;
  result: HealthCheckResult;
  onClose: () => void;
  onCopy: () => void;
  onAskClaude: () => void;
  onRerun: () => void;
}

function HealthErrorModal({
  category,
  result,
  onClose,
  onCopy,
  onAskClaude,
  onRerun,
}: HealthErrorModalProps) {
  const output = result.stdout || result.stderr;

  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title">
            <StatusDot status="fail" size={16} />
            <span>{CATEGORY_LABELS[category]} Check Failed</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <pre className="health-modal-output">{output || 'No output'}</pre>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Exit code: {result.exitCode}</span>
            <span>Duration: {formatDuration(result.durationMs)}</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onCopy}>
              <CopyIcon size={12} />
              Copy Output
            </button>
            <button className="health-modal-btn secondary" onClick={onRerun}>
              Re-run
            </button>
            <button className="health-modal-btn primary" onClick={onAskClaude}>
              Ask Claude to Fix
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Package.json viewer modal
interface PackageJsonModalProps {
  content: string;
  onClose: () => void;
  onCopy: () => void;
}

function PackageJsonModal({ content, onClose, onCopy }: PackageJsonModalProps) {
  // Try to format the JSON nicely
  let formattedContent = content;
  try {
    const parsed: unknown = JSON.parse(content);
    formattedContent = JSON.stringify(parsed, null, 2);
  } catch {
    // If parsing fails, use the raw content
  }

  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal health-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title health-modal-title-neutral">
            <FileIcon size={16} />
            <span>package.json</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <pre className="health-modal-output health-modal-json">{formattedContent}</pre>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Read-only view</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onCopy}>
              <CopyIcon size={12} />
              Copy
            </button>
            <button className="health-modal-btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Suggestions modal for adding missing scripts
interface SuggestionsModalProps {
  suggestions: ScriptSuggestion[];
  onClose: () => void;
  onCopy: (text: string) => void;
  onAskClaude?: (suggestions: ScriptSuggestion[]) => void;
}

function SuggestionsModal({ suggestions, onClose, onCopy, onAskClaude }: SuggestionsModalProps) {
  return (
    <div className="health-modal-overlay" onClick={onClose}>
      <div className="health-modal" onClick={(e) => e.stopPropagation()}>
        <div className="health-modal-header">
          <div className="health-modal-title health-modal-title-neutral">
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>Suggested Scripts</span>
          </div>
          <button className="health-modal-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="health-modal-content">
          <p className="health-suggestions-intro">
            The following packages are installed but don't have corresponding scripts in your
            package.json. Add these scripts to enable health checks:
          </p>
          <div className="health-suggestions-list">
            {suggestions.map((suggestion, index) => (
              <div key={index} className="health-suggestion-item">
                <div className="health-suggestion-header">
                  <span className="health-suggestion-category">
                    {CATEGORY_LABELS[suggestion.category]}
                  </span>
                  <span className="health-suggestion-reason">{suggestion.reason}</span>
                </div>
                <div className="health-suggestion-script">
                  <code>
                    "{suggestion.scriptName}": "{suggestion.scriptCommand}"
                  </code>
                  <button
                    className="health-suggestion-copy"
                    onClick={() =>
                      onCopy(`"${suggestion.scriptName}": "${suggestion.scriptCommand}"`)
                    }
                    title="Copy to clipboard"
                  >
                    <CopyIcon size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="health-modal-footer">
          <div className="health-modal-meta">
            <span>Add these to your package.json "scripts" section</span>
          </div>
          <div className="health-modal-actions">
            <button className="health-modal-btn secondary" onClick={onClose}>
              Close
            </button>
            {onAskClaude && (
              <button className="health-modal-btn primary" onClick={() => onAskClaude(suggestions)}>
                Ask Claude to Add
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
