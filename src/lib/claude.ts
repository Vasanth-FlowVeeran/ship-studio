/**
 * Agent CLI integration utilities.
 *
 * Provides functions for:
 * - Checking agent CLI installation status and version
 * - Installing the agent CLI globally
 *
 * The active agent (currently Claude Code) powers the terminal experience.
 *
 * @module lib/claude
 */

import { invoke } from '@tauri-apps/api/core';

/** Agent CLI installation status */
export interface AgentCliStatus {
  /** Whether agent CLI is installed */
  installed: boolean;
  /** Installed version string (e.g., "2.1.14") or null if not installed */
  version: string | null;
}

/** @deprecated Use AgentCliStatus instead */
export type ClaudeCliStatus = AgentCliStatus;

/**
 * Check agent CLI installation status.
 * @returns CLI status with installed flag and version
 */
export async function checkAgentCliStatus(): Promise<AgentCliStatus> {
  return invoke<AgentCliStatus>('check_claude_cli_status');
}

/** @deprecated Use checkAgentCliStatus instead */
export const checkClaudeCliStatus = checkAgentCliStatus;

/**
 * Install the agent CLI globally.
 */
export async function installAgentCli(): Promise<void> {
  return invoke('install_claude_cli');
}

/** @deprecated Use installAgentCli instead */
export const installClaudeCli = installAgentCli;

/** Represents an agent skill (custom command) */
export interface AgentSkill {
  /** Skill name (command without the leading /) */
  name: string;
  /** Short description of what the skill does */
  description: string;
  /** The plugin this skill belongs to */
  plugin: string;
  /** Whether this is a "user" or "project" scoped skill */
  scope: string;
}

/** @deprecated Use AgentSkill instead */
export type ClaudeSkill = AgentSkill;

/**
 * List available agent skills from installed plugins.
 * @param projectPath - Optional project path to include project-level skills
 * @param agentId - Optional agent ID to list skills for a specific agent
 * @returns Array of available skills
 */
export async function listAgentSkills(
  projectPath?: string,
  agentId?: string
): Promise<AgentSkill[]> {
  return invoke<AgentSkill[]>('list_claude_skills', { projectPath, agentId });
}

/** @deprecated Use listAgentSkills instead */
export const listClaudeSkills = listAgentSkills;
