/**
 * PluginsDropdown — left-cluster header dropdown that lists the plugin
 * manager plus every currently-loaded plugin. Matches the visual shape
 * of `ToolbarDropdown` (toolbar-icon-btn trigger, `.toolbar-dropdown-menu`
 * body) so both live-together consistently in the header.
 *
 * Current behavior: every row (including individual plugins) opens the
 * Plugin Manager. Tried wiring rows to render each plugin's `toolbar`
 * slot component inline so clicks would trigger the plugin directly, but
 * plugins like Webflow-to-Code render their Modal as a sibling of the
 * trigger button, which makes it fragile to mount/unmount inside a
 * transient dropdown. Revisit when plugins have a proper `openUI()`
 * export or portal-based popups.
 *
 * @module components/PluginsDropdown
 */

import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { ChevronIcon, PuzzleIcon } from './icons';
import type { LoadedPlugin } from '../hooks/usePlugins';

interface PluginsDropdownProps {
  plugins: LoadedPlugin[];
  onOpenPluginManager: () => void;
}

export function PluginsDropdown({ plugins, onOpenPluginManager }: PluginsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  return (
    <div className="toolbar-dropdown-container" ref={menuRef}>
      <button
        className={`toolbar-icon-btn ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Plugins"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-education-id="plugins-dropdown"
      >
        <span className="toolbar-btn-label">Plugins</span>
        <ChevronIcon size={10} className={isOpen ? 'chevron-flipped' : undefined} />
      </button>

      {isOpen && (
        <div className="toolbar-dropdown-menu">
          <button
            className="toolbar-dropdown-item"
            onClick={() => {
              setIsOpen(false);
              onOpenPluginManager();
            }}
          >
            <PuzzleIcon size={14} />
            <span>Plugin Manager</span>
          </button>
          {plugins.length > 0 && <div className="toolbar-dropdown-divider" />}
          {plugins.map((plugin) => {
            /* Render the plugin's real brand logo via its toolbar slot
               component — `.plugin-dropdown-icon` neutralizes the
               plugin's button chrome so only the SVG survives. Click
               opens the Plugin Manager for now (see module doc). */
            const ToolbarIcon = plugin.module.slots['toolbar'];
            return (
              <button
                key={plugin.info.manifest.id}
                className="toolbar-dropdown-item"
                onClick={() => {
                  setIsOpen(false);
                  onOpenPluginManager();
                }}
                title={plugin.info.manifest.description}
              >
                <span className="plugin-dropdown-icon" aria-hidden="true">
                  {ToolbarIcon ? <ToolbarIcon /> : <PuzzleIcon size={14} />}
                </span>
                <span>{plugin.info.manifest.name}</span>
              </button>
            );
          })}
          {plugins.length === 0 && (
            <div className="toolbar-dropdown-empty-hint">No plugins installed yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
