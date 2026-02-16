/**
 * TerminalTabDropdown - dropdown menu for individual terminal tabs.
 *
 * Shows an agent selector and tab actions (close tab).
 *
 * @module components/TerminalTabDropdown
 */

import { useState, useRef, useCallback } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { ChevronIcon, CloseIcon, CheckIcon } from './icons';
import { ALL_AGENTS, TERMINAL } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';

interface TerminalTabDropdownProps {
  currentAgent: AgentConfig;
  onSwitchAgent: (agentId: string) => void;
  onClose: () => void;
}

export function TerminalTabDropdown({
  currentAgent,
  onSwitchAgent,
  onClose,
}: TerminalTabDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  return (
    <div className="terminal-tab-dropdown-container" ref={menuRef}>
      <span
        className="terminal-tab-chevron"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
      >
        <ChevronIcon size={10} />
      </span>

      {isOpen && (
        <div className="terminal-tab-dropdown-menu">
          {ALL_AGENTS.map((agent) => (
            <button
              key={agent.id}
              className={`terminal-tab-dropdown-item ${agent.id === currentAgent.id ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (agent.id !== currentAgent.id) {
                  onSwitchAgent(agent.id);
                }
                setIsOpen(false);
              }}
            >
              {agent.id === currentAgent.id ? (
                <CheckIcon size={12} />
              ) : (
                <span style={{ width: 12 }} />
              )}
              <span>{agent.displayName}</span>
            </button>
          ))}
          <div className="terminal-tab-dropdown-divider" />
          <button
            className={`terminal-tab-dropdown-item ${TERMINAL.id === currentAgent.id ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (TERMINAL.id !== currentAgent.id) {
                onSwitchAgent(TERMINAL.id);
              }
              setIsOpen(false);
            }}
          >
            {TERMINAL.id === currentAgent.id ? (
              <CheckIcon size={12} />
            ) : (
              <span style={{ width: 12 }} />
            )}
            <span>{TERMINAL.displayName}</span>
          </button>
          <div className="terminal-tab-dropdown-divider" />
          <button
            className="terminal-tab-dropdown-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
              onClose();
            }}
          >
            <CloseIcon size={12} />
            <span>Close tab</span>
          </button>
        </div>
      )}
    </div>
  );
}
