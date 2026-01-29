/**
 * ProjectCardMenu component - dropdown menu for project card actions.
 *
 * Provides options for:
 * - Toggling auto-accept mode (Claude runs with --dangerously-skip-permissions)
 * - Deleting the project
 *
 * Shows a first-time warning when enabling auto-accept mode.
 *
 * @module components/ProjectCardMenu
 */

import { useState, useRef, useCallback } from 'react';
import { ZapIcon, TrashIcon, FolderIcon } from './icons';
import { useClickOutside } from '../hooks/useClickOutside';

/** Local storage key for tracking if user has seen the auto-accept warning */
const AUTO_ACCEPT_WARNING_SEEN_KEY = 'ship-studio-auto-accept-warning-seen';

interface ProjectCardMenuProps {
  /** Whether auto-accept mode is currently enabled */
  autoAcceptMode: boolean;
  /** Callback when auto-accept mode is toggled */
  onToggleAutoAccept: (enabled: boolean) => void;
  /** Callback to move project to a folder */
  onMoveToFolder?: () => void;
  /** Callback when delete is clicked */
  onDelete: () => void;
}

export function ProjectCardMenu({
  autoAcceptMode,
  onToggleAutoAccept,
  onMoveToFolder,
  onDelete,
}: ProjectCardMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!autoAcceptMode) {
      // Check if user has seen the warning before
      const hasSeenWarning = localStorage.getItem(AUTO_ACCEPT_WARNING_SEEN_KEY) === 'true';
      if (!hasSeenWarning) {
        setShowWarning(true);
        setIsOpen(false);
        return;
      }
    }

    onToggleAutoAccept(!autoAcceptMode);
    setIsOpen(false);
  };

  const handleWarningAccept = () => {
    localStorage.setItem(AUTO_ACCEPT_WARNING_SEEN_KEY, 'true');
    onToggleAutoAccept(true);
    setShowWarning(false);
  };

  const handleWarningCancel = () => {
    setShowWarning(false);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onDelete();
  };

  const handleMoveToFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onMoveToFolder?.();
  };

  const handleMenuButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  return (
    <>
      <div className="project-card-menu-container" ref={menuRef}>
        <button
          className="project-card-menu"
          onClick={handleMenuButtonClick}
          title="Project options"
        >
          &bull;&bull;&bull;
        </button>

        {isOpen && (
          <div className="project-card-dropdown">
            <button
              className={`project-card-dropdown-item ${autoAcceptMode ? 'active' : ''}`}
              onClick={handleToggleClick}
            >
              <ZapIcon size={14} />
              <span>Auto-accept mode</span>
              <span className={`toggle-indicator ${autoAcceptMode ? 'on' : 'off'}`}>
                {autoAcceptMode ? 'ON' : 'OFF'}
              </span>
            </button>
            {onMoveToFolder && (
              <button className="project-card-dropdown-item" onClick={handleMoveToFolderClick}>
                <FolderIcon size={14} />
                <span>Move to folder</span>
              </button>
            )}
            <div className="project-card-dropdown-divider" />
            <button className="project-card-dropdown-item danger" onClick={handleDeleteClick}>
              <TrashIcon size={14} />
              <span>Delete project</span>
            </button>
          </div>
        )}
      </div>

      {/* Auto-accept warning modal */}
      {showWarning && (
        <div className="modal-overlay" onClick={handleWarningCancel}>
          <div className="modal auto-accept-warning-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auto-accept-warning-icon">
              <ZapIcon size={32} />
            </div>
            <h3>Enable Auto-Accept Mode?</h3>
            <p>
              This mode allows Claude to execute commands{' '}
              <strong>without asking for permission</strong>. Claude will be able to:
            </p>
            <ul className="auto-accept-warning-list">
              <li>Read and modify any files in your project</li>
              <li>Run shell commands automatically</li>
              <li>Make changes without confirmation</li>
            </ul>
            <p className="auto-accept-warning-disclaimer">
              By enabling this mode, you acknowledge that Ship Studio and Anthropic are{' '}
              <strong>not liable</strong> for any unintended changes or actions taken by the AI.
            </p>
            <div className="modal-actions">
              <button onClick={handleWarningCancel}>Cancel</button>
              <button className="btn-warning" onClick={handleWarningAccept}>
                I understand, enable it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
