/**
 * PluginSlot renders plugin components in designated UI locations.
 *
 * Each plugin slot wraps its plugins in a PluginContext.Provider
 * and an error boundary to isolate crashes.
 *
 * @module components/PluginSlot
 */

import { Component, type ReactNode, useState } from 'react';
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

export function PluginSlot({ name, plugins, project, actions, theme }: PluginSlotProps) {
  if (plugins.length === 0) return null;

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
        // Expose context on namespaced map for raw-JS plugins
        const pluginsMap = ((
          window as unknown as Record<string, unknown>
        ).__SHIPSTUDIO_PLUGINS__ ??= {}) as Record<string, PluginContextValue>;
        pluginsMap[plugin.info.manifest.id] = ctx;
        // Legacy single-global write for v0 compat (last-writer-wins)
        exposePluginContext(ctx);

        return (
          <PluginContext.Provider key={plugin.info.manifest.id} value={ctx}>
            <PluginErrorBoundary
              pluginId={plugin.info.manifest.id}
              pluginName={plugin.info.manifest.name}
              compact={name === 'toolbar' || name === 'preview'}
            >
              <SlotComponent />
            </PluginErrorBoundary>
          </PluginContext.Provider>
        );
      })}
    </>
  );
}
