/**
 * PluginSlot renders plugin components in designated UI locations.
 *
 * Each plugin slot wraps its plugins in a PluginContext.Provider
 * and an error boundary to isolate crashes.
 *
 * @module components/PluginSlot
 */

import { Component, type ReactNode, useState, useRef, useEffect, type ComponentType } from 'react';
import {
  PluginContext,
  exposePluginContext,
  type PluginContextValue,
  type PluginProjectData,
  type PluginAppActions,
  type PluginThemeData,
} from '../contexts/PluginContext';
import { execPluginShell, readPluginStorage, writePluginStorage } from '../lib/plugins';
import { invoke } from '@tauri-apps/api/core';
import type { LoadedPlugin } from '../hooks/usePlugins';

interface PluginSlotProps {
  /** Slot name (e.g., "toolbar", "sidebar") */
  name: string;
  /** Plugins registered for this slot */
  plugins: LoadedPlugin[];
  /** Current project data */
  project: PluginProjectData | null;
  /** App actions for plugins */
  actions: PluginAppActions;
  /** Theme data for consistent styling */
  theme: PluginThemeData;
}

/** Error boundary state */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  pluginId: string;
  pluginName: string;
  compact: boolean;
  children: ReactNode;
}

/** Inline fallback for expanded (non-toolbar) plugin errors */
function PluginErrorFallback({
  pluginName,
  error,
  onRetry,
}: {
  pluginName: string;
  error: Error | null;
  onRetry: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ color: 'var(--error)' }}>!</span>
        <span>
          <strong>{pluginName}</strong> crashed: {error?.message || 'Unknown error'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        <button
          onClick={() => setShowDetails((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 0,
            fontSize: '11px',
            textDecoration: 'underline',
          }}
        >
          {showDetails ? 'Hide Details' : 'Details'}
        </button>
        <button
          onClick={onRetry}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            padding: 0,
            fontSize: '11px',
            textDecoration: 'underline',
          }}
        >
          Retry
        </button>
      </div>
      {showDetails && error?.stack && (
        <pre
          style={{
            marginTop: '4px',
            fontSize: '10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: 'var(--text-muted)',
            maxHeight: '120px',
            overflow: 'auto',
          }}
        >
          {error.stack}
        </pre>
      )}
    </div>
  );
}

/**
 * Outermost isolation boundary — wraps the entire plugin render including
 * the Context.Provider. Catches errors that escape the inner PluginErrorBoundary
 * (e.g. plugins bundling their own React, errors during Provider setup, or
 * dual-React-instance edge cases).
 */
class PluginIsolationBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[PluginIsolation] Plugin "${this.props.pluginId}" crashed (outer boundary):`,
      error
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.compact) {
        return (
          <span
            className="plugin-error-indicator"
            title={`${this.props.pluginName} crashed: ${this.state.error?.message || 'Unknown error'}`}
          >
            !
          </span>
        );
      }

      return (
        <PluginErrorFallback
          pluginName={this.props.pluginName}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}

/** Error boundary that isolates plugin crashes */
class PluginErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(`Plugin ${this.props.pluginId} crashed:`, error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.compact) {
        return (
          <span
            className="plugin-error-indicator"
            title={`${this.props.pluginName} crashed: ${this.state.error?.message || 'Unknown error'}\n\n${this.state.error?.stack || ''}`}
          >
            !
          </span>
        );
      }

      return (
        <PluginErrorFallback
          pluginName={this.props.pluginName}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}

/** Build a PluginContextValue for a specific plugin */
function buildContext(
  pluginId: string,
  project: PluginProjectData | null,
  actions: PluginAppActions,
  theme: PluginThemeData,
  requiredCommands: string[]
): PluginContextValue {
  const projectPath = project?.path || '';
  const allowedCommands = new Set(requiredCommands);

  return {
    pluginId,
    project,
    actions,
    shell: {
      exec: (command: string, args: string[], options?: { timeout?: number }) =>
        execPluginShell(pluginId, projectPath, command, args, options?.timeout),
    },
    storage: {
      read: () => readPluginStorage(pluginId, projectPath),
      write: (data: Record<string, unknown>) => writePluginStorage(pluginId, projectPath, data),
    },
    invoke: {
      call: <T = unknown,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (!allowedCommands.has(command)) {
          return Promise.reject(
            new Error(`Plugin "${pluginId}" is not allowed to call "${command}"`)
          );
        }
        return invoke<T>(command, args);
      },
    },
    theme,
  };
}

/**
 * Safely renders a plugin component inside a container div.
 *
 * Some plugins bundle their own React, causing hook errors that escape
 * React error boundaries entirely. This wrapper catches those by:
 * 1. Rendering the plugin component inside an isolated container
 * 2. Listening for error events that originate from plugin blob: URLs
 * 3. Replacing crashed plugin content with an inline error indicator
 */
function SafePluginWrapper({
  Component: PluginComponent,
  pluginId,
  pluginName,
  compact,
}: {
  Component: ComponentType;
  pluginId: string;
  pluginName: string;
  compact: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [caughtError, setCaughtError] = useState<Error | null>(null);

  useEffect(() => {
    function handleError(event: ErrorEvent) {
      // Only intercept errors from plugin blob: URLs
      if (!event.filename?.startsWith('blob:')) return;

      // Check if this error is within our plugin's container
      // (blob URLs don't include plugin IDs, so catch all blob errors
      // and rely on the error boundary for per-plugin attribution)
      event.preventDefault();
      event.stopImmediatePropagation();
      console.error(`Plugin "${pluginId}" error caught by safety wrapper:`, event.error);
      setCaughtError(event.error instanceof Error ? event.error : new Error(event.message));
    }

    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, [pluginId]);

  if (caughtError) {
    if (compact) {
      return (
        <span
          className="plugin-error-indicator"
          title={`${pluginName} crashed: ${caughtError.message}`}
        >
          !
        </span>
      );
    }
    return (
      <PluginErrorFallback
        pluginName={pluginName}
        error={caughtError}
        onRetry={() => setCaughtError(null)}
      />
    );
  }

  return (
    <div ref={containerRef} style={{ display: 'contents' }}>
      <PluginComponent />
    </div>
  );
}

export function PluginSlot({ name, plugins, project, actions, theme }: PluginSlotProps) {
  if (plugins.length === 0) return null;

  const compact = name === 'toolbar' || name === 'preview';

  return (
    <>
      {plugins.map((plugin) => {
        const SlotComponent = plugin.module.slots[name];
        if (!SlotComponent) return null;

        const ctx = buildContext(
          plugin.info.manifest.id,
          project,
          actions,
          theme,
          plugin.info.manifest.required_commands || []
        );

        // Expose context on window globals for raw-JS and legacy plugins.
        // Must be synchronous (before plugin component renders) so plugins
        // that read the legacy global during their first render can find it.
        const pluginsMap = ((
          window as unknown as Record<string, unknown>
        ).__SHIPSTUDIO_PLUGINS__ ??= {}) as Record<string, PluginContextValue>;
        pluginsMap[plugin.info.manifest.id] = ctx;
        exposePluginContext(ctx);

        return (
          <PluginIsolationBoundary
            key={plugin.info.manifest.id}
            pluginId={plugin.info.manifest.id}
            pluginName={plugin.info.manifest.name}
            compact={compact}
          >
            <PluginContext.Provider value={ctx}>
              <PluginErrorBoundary
                pluginId={plugin.info.manifest.id}
                pluginName={plugin.info.manifest.name}
                compact={compact}
              >
                <SafePluginWrapper
                  Component={SlotComponent}
                  pluginId={plugin.info.manifest.id}
                  pluginName={plugin.info.manifest.name}
                  compact={compact}
                />
              </PluginErrorBoundary>
            </PluginContext.Provider>
          </PluginIsolationBoundary>
        );
      })}
    </>
  );
}
