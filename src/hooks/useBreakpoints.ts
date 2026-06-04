/**
 * Detect the project's Tailwind breakpoints for the visual editor.
 *
 * Wraps the `detect_breakpoints` backend command (Tailwind v4 `@theme` /
 * v3 `theme.screens`, with a default fallback), prepends the base (unprefixed)
 * layer, and caches the result. Falls back to Tailwind's defaults while loading
 * or on error so the editor always has a usable breakpoint set.
 */

import { useState, useEffect } from 'react';
import {
  detectBreakpoints,
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  type Breakpoint,
} from '../lib/edit';
import { logger } from '../lib/logger';

/** Base layer + Tailwind defaults — the fallback before detection resolves. */
const DEFAULT_ORDERED: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];

/**
 * The project's breakpoints (Base prepended), ascending by min-width. Re-detects
 * when the project changes; returns Tailwind defaults until then / on failure.
 *
 * The detected result is tagged with the project it belongs to, so the return
 * falls back to defaults whenever the cached result is for a different project
 * (or the editor is disabled) — no synchronous setState in the effect, and no
 * stale breakpoints flashing through after a project switch.
 */
export function useBreakpoints(projectPath: string, enabled: boolean): Breakpoint[] {
  const [detected, setDetected] = useState<{ path: string; breakpoints: Breakpoint[] } | null>(
    null
  );

  useEffect(() => {
    if (!enabled || !projectPath) return;
    let alive = true;
    void (async () => {
      try {
        const bps = await detectBreakpoints(projectPath);
        if (alive) setDetected({ path: projectPath, breakpoints: [BASE_BREAKPOINT, ...bps] });
      } catch (err) {
        logger.error('[useBreakpoints] detection failed, using defaults', {
          error: String(err),
        });
        if (alive) setDetected({ path: projectPath, breakpoints: DEFAULT_ORDERED });
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, enabled]);

  return enabled && detected?.path === projectPath ? detected.breakpoints : DEFAULT_ORDERED;
}
