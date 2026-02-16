/**
 * Skills management utilities for Claude Code.
 *
 * Provides functions for:
 * - Searching for skills via the Skills CLI
 * - Installing and removing skills
 * - Checking Skills CLI availability
 *
 * @module lib/skills
 */

import { invoke } from '@tauri-apps/api/core';

// Re-export from claude.ts for convenience
export { listClaudeSkills, type ClaudeSkill } from './claude';

/** Represents a skill search result from the Skills CLI */
export interface SkillSearchResult {
  /** Skill name */
  name: string;
  /** Package identifier (e.g., "owner/repo") */
  package: string;
  /** Short description of the skill */
  description: string;
  /** Number of installs (if available) */
  installs?: number;
}

/**
 * Check if the Skills CLI is available.
 * @returns true if npx skills is available
 */
export async function checkSkillsCli(): Promise<boolean> {
  return invoke<boolean>('check_skills_cli');
}

/**
 * Search for skills using the Skills CLI.
 * @param query - Search query (e.g., "create PDF documents")
 * @returns Array of matching skills
 */
export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  return invoke<SkillSearchResult[]>('search_skills', { query });
}

/**
 * Install a skill using the Skills CLI.
 * @param pkg - Package identifier (e.g., "owner/repo")
 * @param scope - Installation scope: "user" or "project"
 * @param projectPath - Required for project-scoped installation
 * @param agentId - Optional agent ID to install for a specific agent
 */
export async function installSkill(
  pkg: string,
  scope: 'user' | 'project',
  projectPath?: string,
  agentId?: string
): Promise<void> {
  return invoke('install_skill', { package: pkg, scope, projectPath, agentId });
}

/**
 * Remove a skill using the Skills CLI.
 * @param pkg - Package identifier (e.g., "owner/repo")
 * @param scope - Installation scope: "user" or "project"
 * @param projectPath - Required for project-scoped removal
 * @param agentId - Optional agent ID to remove for a specific agent
 */
export async function removeSkill(
  pkg: string,
  scope: 'user' | 'project',
  projectPath?: string,
  agentId?: string
): Promise<void> {
  return invoke('remove_skill', { package: pkg, scope, projectPath, agentId });
}
