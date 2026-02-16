/**
 * Custom hook for managing terminal tabs and sessions.
 *
 * Extracted from App.tsx to reduce component complexity. This hook encapsulates
 * all terminal tab state and logic, which is self-contained and frequently used
 * throughout the workspace UI.
 *
 * Provides state and callbacks for creating, closing, and switching between
 * terminal tabs, as well as killing all terminal processes.
 *
 * @module hooks/useTerminalManagement
 */

import { useState, useRef, useCallback } from 'react';
import type { TerminalHandle } from '../components/Terminal';
import { getAgentById, getDefaultAgentId } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';

/** Maximum number of terminal tabs allowed */
const MAX_TERMINAL_TABS = 5;

/** A terminal tab with its own agent assignment. */
export interface TerminalTab {
  id: number;
  agentId: string;
}

/** Return type for useTerminalManagement hook */
export interface UseTerminalManagementReturn {
  /** Array of terminal tabs */
  terminalTabs: TerminalTab[];
  /** Currently active terminal tab ID */
  activeTerminalTab: number;
  /** Session ID that changes when project changes (forces terminal remount) */
  terminalSessionId: number;
  /** Map of tab IDs to terminal refs */
  terminalRefsMap: React.MutableRefObject<Map<number, TerminalHandle | null>>;
  /** Maximum number of terminal tabs allowed */
  maxTerminalTabs: number;
  /** Set the active terminal tab */
  setActiveTerminalTab: (tabId: number) => void;
  /** Add a new terminal tab */
  addTerminalTab: () => void;
  /** Close a terminal tab by ID */
  closeTerminalTab: (tabId: number) => void;
  /** Kill all terminal processes */
  killAllTerminals: () => void;
  /** Reset terminals for a new project */
  resetTerminals: () => void;
  /** Get the ref for the active terminal */
  getActiveTerminalRef: () => TerminalHandle | null;
  /** Focus the active terminal */
  focusActiveTerminal: () => void;
  /** Paste text into the active terminal */
  pasteToActiveTerminal: (text: string) => void;
  /** Switch the agent for a specific tab (kills PTY and remounts) */
  switchTabAgent: (tabId: number, agentId: string) => void;
  /** Get the agent config for the currently active tab */
  getActiveTabAgent: () => AgentConfig;
}

/**
 * Hook for managing terminal tabs and sessions.
 *
 * @example
 * ```tsx
 * const {
 *   terminalTabs,
 *   activeTerminalTab,
 *   addTerminalTab,
 *   closeTerminalTab,
 *   focusActiveTerminal
 * } = useTerminalManagement();
 *
 * // Add a new tab
 * addTerminalTab();
 *
 * // Close a specific tab
 * closeTerminalTab(tabId);
 *
 * // Focus the active terminal
 * focusActiveTerminal();
 * ```
 *
 * @returns Terminal management state and control functions
 */
export function useTerminalManagement(): UseTerminalManagementReturn {
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([
    { id: 1, agentId: getDefaultAgentId() },
  ]);
  const [activeTerminalTab, setActiveTerminalTab] = useState(1);
  const [terminalSessionId, setTerminalSessionId] = useState(1);
  const terminalRefsMap = useRef<Map<number, TerminalHandle | null>>(new Map());
  const terminalTabCounterRef = useRef(1);

  const killAllTerminals = useCallback(() => {
    terminalRefsMap.current.forEach((ref) => {
      ref?.kill();
    });
    terminalRefsMap.current.clear();
  }, []);

  const addTerminalTab = useCallback(() => {
    if (terminalTabs.length >= MAX_TERMINAL_TABS) return;
    const newTabId = ++terminalTabCounterRef.current;
    setTerminalTabs((prev) => [...prev, { id: newTabId, agentId: getDefaultAgentId() }]);
    setActiveTerminalTab(newTabId);
  }, [terminalTabs.length]);

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      // Don't close if it's the last tab
      if (terminalTabs.length <= 1) return;

      // Kill the PTY process BEFORE removing from state to prevent orphaned processes
      const ref = terminalRefsMap.current.get(tabId);
      if (ref) {
        ref.kill();
      }

      setTerminalTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabId);
        // If we're closing the active tab, switch to the previous one or the first
        if (tabId === activeTerminalTab) {
          const closedIndex = prev.findIndex((t) => t.id === tabId);
          const newActiveIndex = Math.max(0, closedIndex - 1);
          setActiveTerminalTab(newTabs[newActiveIndex].id);
        }
        return newTabs;
      });
      // Clean up the ref
      terminalRefsMap.current.delete(tabId);
    },
    [terminalTabs, activeTerminalTab]
  );

  const resetTerminals = useCallback(() => {
    killAllTerminals();
    terminalTabCounterRef.current = 1;
    setTerminalTabs([{ id: 1, agentId: getDefaultAgentId() }]);
    setActiveTerminalTab(1);
    setTerminalSessionId((prev) => prev + 1);
  }, [killAllTerminals]);

  const getActiveTerminalRef = useCallback(() => {
    return terminalRefsMap.current.get(activeTerminalTab) ?? null;
  }, [activeTerminalTab]);

  const focusActiveTerminal = useCallback(() => {
    terminalRefsMap.current.get(activeTerminalTab)?.focus();
  }, [activeTerminalTab]);

  const pasteToActiveTerminal = useCallback(
    (text: string) => {
      terminalRefsMap.current.get(activeTerminalTab)?.paste(text);
    },
    [activeTerminalTab]
  );

  const switchTabAgent = useCallback((tabId: number, agentId: string) => {
    // Kill the existing PTY for this tab
    const ref = terminalRefsMap.current.get(tabId);
    if (ref) {
      ref.kill();
    }
    terminalRefsMap.current.delete(tabId);

    // Update the tab's agent
    setTerminalTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, agentId } : t)));

    // Increment session ID to force remount of the terminal
    setTerminalSessionId((prev) => prev + 1);
  }, []);

  const getActiveTabAgent = useCallback((): AgentConfig => {
    const tab = terminalTabs.find((t) => t.id === activeTerminalTab);
    return tab ? getAgentById(tab.agentId) : getAgentById(getDefaultAgentId());
  }, [terminalTabs, activeTerminalTab]);

  return {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    terminalRefsMap,
    maxTerminalTabs: MAX_TERMINAL_TABS,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    killAllTerminals,
    resetTerminals,
    getActiveTerminalRef,
    focusActiveTerminal,
    pasteToActiveTerminal,
    switchTabAgent,
    getActiveTabAgent,
  };
}
