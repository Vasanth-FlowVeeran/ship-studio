import type { ReactNode } from 'react';
import type { PaletteContextKind } from '../components/CommandPalette/paletteContext';

export type CommandCategory =
  | 'action'
  | 'navigation'
  | 'project'
  | 'branch'
  | 'plugin'
  | 'settings';

export interface PaletteCtx {
  kind: PaletteContextKind;
  currentProjectName: string | null;
}

/**
 * A single palette-contributed command.
 *
 * Colocate declarations with the feature's handlers via `useCommands()`.
 * Keep `run` idempotent and surface errors via toast — silent failures
 * break user trust in the palette.
 */
export interface Command {
  /** Globally unique, namespaced: `domain.verb` (e.g. `branches.switch`). */
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Extra words to match against during fuzzy search. */
  keywords?: string[];
  /** Display-only shortcut hint (e.g. `⌘⇧P`). Doesn't actually bind the key. */
  shortcut?: string;
  category: CommandCategory;
  /**
   * Context gating — either a single context kind ('home'/'project') or a
   * predicate evaluated fresh at palette-open time. Omit to show everywhere.
   */
  when?: PaletteContextKind | ((ctx: PaletteCtx) => boolean);
  /** The handler. Called after the palette has closed. */
  run: () => void | Promise<void>;
}

export function matchesContext(when: Command['when'], ctx: PaletteCtx): boolean {
  if (!when) return true;
  if (typeof when === 'string') return when === ctx.kind;
  return when(ctx);
}
