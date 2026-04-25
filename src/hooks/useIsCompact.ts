/**
 * Returns `true` when the window is narrow enough that the workspace should
 * swap to the CompactWorkspace layout. Purely width-driven — no manual
 * toggle, no Tauri resize; users enter/exit by dragging the window across
 * the threshold. Kept as a single source of truth so JS branching and CSS
 * scoping stay aligned on one number.
 *
 * @module hooks/useIsCompact
 */

import { useEffect, useState } from 'react';

export const COMPACT_BREAKPOINT = 750;

function readIsCompact() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < COMPACT_BREAKPOINT;
}

export function useIsCompact(): boolean {
  const [isCompact, setIsCompact] = useState(readIsCompact);

  useEffect(() => {
    const handler = () => setIsCompact(readIsCompact());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return isCompact;
}
