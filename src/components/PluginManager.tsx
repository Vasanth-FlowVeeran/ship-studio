/**
 * PluginManager component for installing, managing, and removing plugins.
 *
 * Plugins are project-level: each project has its own set of plugins.
 * The "Library" tab fetches available plugins from the remote registry.
 *
 * @module components/PluginManager
 */

import { useEffect, useState, useCallback } from 'react';
import { CloseIcon } from './icons';
import {
  listPlugins,
  installPlugin,
  uninstallPlugin,
  togglePlugin,
  checkPluginUpdate,
  updatePlugin,
  fetchPluginRegistry,
  linkDevPlugin,
  unlinkDevPlugin,
  type PluginInfo,
  type PluginRegistryEntry,
} from '../lib/plugins';

type Tab = 'installed' | 'library';

interface PluginManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onPluginsChanged: () => void;
  projectPath: string | null;
}

export function PluginManager({
  isOpen,
  onClose,
  onPluginsChanged,
  projectPath,
}: PluginManagerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('installed');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Update state per plugin: 'idle' | 'checking' | 'available' | 'up_to_date' | 'updating'
  const [updateStates, setUpdateStates] = useState<Record<string, string>>({});

  // Library state
  const [registry, setRegistry] = useState<PluginRegistryEntry[]>([]);
  const [isLoadingRegistry, setIsLoadingRegistry] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [isInstallingUrl, setIsInstallingUrl] = useState(false);

  // Dev plugin state
  const [isLinkingDev, setIsLinkingDev] = useState(false);
  const [reloadingId, setReloadingId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch installed plugins when modal opens
  const fetchPlugins = useCallback(async () => {
    if (!projectPath) {
      setPlugins([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = await listPlugins(projectPath);
      setPlugins(result);
    } catch (err) {
      console.error('Failed to load plugins:', err);
      setPlugins([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!isOpen) return;
    fetchPlugins();
  }, [isOpen, fetchPlugins]);

  // Fetch registry when library tab is selected
  const fetchRegistry = useCallback(async () => {
    setIsLoadingRegistry(true);
    try {
      const result = await fetchPluginRegistry();
      setRegistry(result);
    } catch (err) {
      console.error('Failed to fetch plugin registry:', err);
      setRegistry([]);
    } finally {
      setIsLoadingRegistry(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || activeTab !== 'library') return;
    fetchRegistry();
  }, [isOpen, activeTab, fetchRegistry]);

  // Handle uninstall
  const handleUninstall = async (pluginId: string) => {
    if (!projectPath) return;
    setRemovingId(pluginId);
    try {
      await uninstallPlugin(projectPath, pluginId);
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      console.error('Failed to uninstall plugin:', err);
    } finally {
      setRemovingId(null);
    }
  };

  // Handle toggle
  const handleToggle = async (pluginId: string, enabled: boolean) => {
    if (!projectPath) return;
    setTogglingId(pluginId);
    try {
      await togglePlugin(projectPath, pluginId, enabled);
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      console.error('Failed to toggle plugin:', err);
    } finally {
      setTogglingId(null);
    }
  };

  // Handle check for update
  const handleCheckUpdate = async (pluginId: string) => {
    if (!projectPath) return;
    setUpdateStates((prev) => ({ ...prev, [pluginId]: 'checking' }));
    try {
      const result = await checkPluginUpdate(projectPath, pluginId);
      setUpdateStates((prev) => ({
        ...prev,
        [pluginId]: result.has_update ? 'available' : 'up_to_date',
      }));
    } catch (err) {
      console.error('Failed to check for update:', err);
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'idle' }));
    }
  };

  // Handle update
  const handleUpdate = async (pluginId: string) => {
    if (!projectPath) return;
    setUpdateStates((prev) => ({ ...prev, [pluginId]: 'updating' }));
    try {
      await updatePlugin(projectPath, pluginId);
      await fetchPlugins();
      onPluginsChanged();
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'up_to_date' }));
    } catch (err) {
      console.error('Failed to update plugin:', err);
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'available' }));
    }
  };

  // Handle install from library
  const handleLibraryInstall = async (entry: PluginRegistryEntry) => {
    if (!projectPath) return;
    setInstallingId(entry.id);
    setError(null);
    try {
      await installPlugin(projectPath, entry.repo);
      await fetchPlugins();
      onPluginsChanged();
      setInstallingId(null);
    } catch (err) {
      console.error('Failed to install plugin:', err);
      setError(err instanceof Error ? err.message : String(err));
      setInstallingId(null);
    }
  };

  // Handle install from URL
  const handleUrlInstall = async () => {
    if (!repoUrl.trim() || !projectPath) return;
    setIsInstallingUrl(true);
    setError(null);
    try {
      await installPlugin(projectPath, repoUrl.trim());
      setRepoUrl('');
      setShowUrlInput(false);
      await fetchPlugins();
      setActiveTab('installed');
      onPluginsChanged();
    } catch (err) {
      console.error('Failed to install plugin:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstallingUrl(false);
    }
  };

  // Handle link dev plugin
  const handleLinkDevPlugin = async () => {
    if (!projectPath) return;
    setIsLinkingDev(true);
    setError(null);
    try {
      const result = await linkDevPlugin(projectPath);
      if (result) {
        await fetchPlugins();
        onPluginsChanged();
      }
    } catch (err) {
      console.error('Failed to link dev plugin:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLinkingDev(false);
    }
  };

  // Handle reload dev plugin
  const handleReloadDevPlugin = async (pluginId: string) => {
    setReloadingId(pluginId);
    try {
      onPluginsChanged();
    } finally {
      // Small delay so spinner is visible
      setTimeout(() => setReloadingId(null), 400);
    }
  };

  // Handle unlink dev plugin
  const handleUnlinkDevPlugin = async (pluginId: string) => {
    if (!projectPath) return;
    setUnlinkingId(pluginId);
    try {
      await unlinkDevPlugin(projectPath, pluginId);
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      console.error('Failed to unlink dev plugin:', err);
    } finally {
      setUnlinkingId(null);
    }
  };

  const installedIds = new Set(plugins.map((p) => p.manifest.id));

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal plugins-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plugins-modal-header">
          <h3>Plugins</h3>
          <button className="plugins-close-btn" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="plugins-tabs">
          <button
            className={`plugins-tab ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            Installed
          </button>
          <button
            className={`plugins-tab ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            Library
          </button>
        </div>

        <div className="plugins-modal-body">
          {!projectPath && (
            <div className="plugins-empty">Open a project to manage its plugins.</div>
          )}

          {projectPath && activeTab === 'installed' && (
            <>
              {isLoading && plugins.length === 0 && (
                <div className="plugins-loading">
                  <div className="plugins-loading-spinner" />
                  Loading plugins...
                </div>
              )}

              {!isLoading && plugins.length === 0 && (
                <div className="plugins-empty">
                  No plugins installed yet. Browse the{' '}
                  <button className="plugins-empty-link" onClick={() => setActiveTab('library')}>
                    Library
                  </button>{' '}
                  to add one.
                </div>
              )}

              <div className="plugins-list">
                {plugins.map((plugin) => (
                  <div key={plugin.manifest.id} className="plugin-row">
                    <div className="plugin-info">
                      <div className="plugin-name">
                        {plugin.manifest.name}
                        {plugin.is_dev && <span className="plugin-dev-badge">DEV</span>}
                      </div>
                      <div className="plugin-meta">
                        <span className="plugin-version">v{plugin.manifest.version}</span>
                        {plugin.manifest.author && (
                          <span className="plugin-author">{plugin.manifest.author}</span>
                        )}
                      </div>
                      {plugin.is_dev && plugin.local_path && (
                        <div className="plugin-local-path" title={plugin.local_path}>
                          {plugin.local_path}
                        </div>
                      )}
                      <div className="plugin-desc">{plugin.manifest.description}</div>
                    </div>
                    <div className="plugin-actions">
                      {plugin.is_dev ? (
                        <button
                          className="plugin-reload-btn"
                          onClick={() => handleReloadDevPlugin(plugin.manifest.id)}
                          disabled={reloadingId === plugin.manifest.id}
                        >
                          {reloadingId === plugin.manifest.id ? 'Reloading...' : 'Reload'}
                        </button>
                      ) : (
                        (() => {
                          const state = updateStates[plugin.manifest.id] || 'idle';
                          if (state === 'checking') {
                            return (
                              <button className="plugin-update-btn" disabled>
                                Checking...
                              </button>
                            );
                          }
                          if (state === 'available') {
                            return (
                              <button
                                className="plugin-update-btn plugin-update-available"
                                onClick={() => handleUpdate(plugin.manifest.id)}
                              >
                                Update
                              </button>
                            );
                          }
                          if (state === 'updating') {
                            return (
                              <button className="plugin-update-btn" disabled>
                                Updating...
                              </button>
                            );
                          }
                          if (state === 'up_to_date') {
                            return (
                              <button className="plugin-update-btn" disabled>
                                Up to date
                              </button>
                            );
                          }
                          return (
                            <button
                              className="plugin-update-btn"
                              onClick={() => handleCheckUpdate(plugin.manifest.id)}
                            >
                              Check for updates
                            </button>
                          );
                        })()
                      )}
                      <button
                        className={`plugin-toggle-btn ${plugin.enabled ? 'enabled' : ''}`}
                        onClick={() => handleToggle(plugin.manifest.id, !plugin.enabled)}
                        disabled={togglingId === plugin.manifest.id}
                        title={plugin.enabled ? 'Disable' : 'Enable'}
                      >
                        {plugin.enabled ? 'On' : 'Off'}
                      </button>
                      {plugin.is_dev ? (
                        <button
                          className="plugin-remove-btn"
                          onClick={() => handleUnlinkDevPlugin(plugin.manifest.id)}
                          disabled={unlinkingId === plugin.manifest.id}
                        >
                          {unlinkingId === plugin.manifest.id ? 'Unlinking...' : 'Unlink'}
                        </button>
                      ) : (
                        <button
                          className="plugin-remove-btn"
                          onClick={() => handleUninstall(plugin.manifest.id)}
                          disabled={removingId === plugin.manifest.id}
                        >
                          {removingId === plugin.manifest.id ? 'Removing...' : 'Remove'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {error && activeTab === 'installed' && <div className="plugins-error">{error}</div>}

              <button
                className="plugins-link-dev-btn"
                onClick={handleLinkDevPlugin}
                disabled={isLinkingDev}
              >
                {isLinkingDev ? 'Linking...' : 'Link Dev Plugin'}
              </button>
            </>
          )}

          {projectPath && activeTab === 'library' && (
            <>
              <div className="plugins-beta-notice">
                Plugins are new and in beta. If you experience any issues, please report them in the
                Slack group.
              </div>

              {isLoadingRegistry && registry.length === 0 && (
                <div className="plugins-loading">
                  <div className="plugins-loading-spinner" />
                  Loading plugin library...
                </div>
              )}

              {!isLoadingRegistry && registry.length === 0 && (
                <div className="plugins-empty">
                  Could not load plugin library. Try installing from a URL below.
                </div>
              )}

              <div className="plugins-list">
                {registry.map((entry) => {
                  const isInstalled = installedIds.has(entry.id);
                  const isThisInstalling = installingId === entry.id;

                  return (
                    <div key={entry.id} className="plugin-row">
                      <div className="plugin-info">
                        <div className="plugin-name">{entry.name}</div>
                        <div className="plugin-meta">
                          <span className="plugin-author">{entry.author}</span>
                          <span className="plugin-category-badge">{entry.category}</span>
                        </div>
                        <div className="plugin-desc">{entry.description}</div>
                      </div>
                      <div className="plugin-actions">
                        {isInstalled ? (
                          <button className="plugin-installed-badge" disabled>
                            Installed
                          </button>
                        ) : (
                          <button
                            className="plugin-library-install-btn"
                            onClick={() => handleLibraryInstall(entry)}
                            disabled={isThisInstalling || installingId !== null}
                          >
                            {isThisInstalling ? 'Installing...' : 'Install'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {error && <div className="plugins-error">{error}</div>}

              <div className="plugins-url-section">
                {!showUrlInput ? (
                  <button className="plugins-url-toggle" onClick={() => setShowUrlInput(true)}>
                    Install from URL
                  </button>
                ) : (
                  <div className="plugins-install-input-wrapper">
                    <input
                      type="text"
                      className="plugins-install-input"
                      placeholder="https://github.com/owner/repo"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleUrlInstall();
                      }}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      autoFocus
                    />
                    <button
                      className="plugins-install-btn"
                      onClick={handleUrlInstall}
                      disabled={isInstallingUrl || !repoUrl.trim()}
                    >
                      {isInstallingUrl ? 'Installing...' : 'Install'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="plugins-footer">
          <span className="plugins-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
        </div>
      </div>
    </div>
  );
}
