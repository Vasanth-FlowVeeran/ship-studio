/**
 * PluginSlot renders plugin components in designated UI locations.
 *
 * Each plugin slot wraps its plugins in a PluginContext.Provider
 * and an error boundary to isolate crashes.
 *
 * @module components/PluginSlot
 */

import { Component, type ReactNode } from 'react';
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

/** Error boundary that isolates plugin crashes */
class PluginErrorBoundary extends Component<
  { pluginId: string; children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { pluginId: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(`Plugin ${this.props.pluginId} crashed:`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <span
          className="plugin-error-indicator"
          title={`Plugin error: ${this.state.error?.message || 'Unknown error'}`}
        >
          !
        </span>
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
      write: (_scope: 'global' | 'project', data: Record<string, unknown>) =>
        writePluginStorage(pluginId, projectPath, data),
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
        // Expose context for SDK window global access
        exposePluginContext(ctx);

        return (
          <PluginContext.Provider key={plugin.info.manifest.id} value={ctx}>
            <PluginErrorBoundary pluginId={plugin.info.manifest.id}>
              <SlotComponent />
            </PluginErrorBoundary>
          </PluginContext.Provider>
        );
      })}
    </>
  );
}
