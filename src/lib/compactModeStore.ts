import { useSyncExternalStore } from 'react';

/**
 * Module-level store for "is compact/pinned mode active right now."
 *
 * `isPinned` state lives inside `useWorkspaceLayout` (scoped to the
 * workspace view), so anything outside that tree — specifically the
 * command palette, which needs to gate Enter/Exit commands — can't read
 * it via props. This lightweight store is written by the workspace when
 * the pin flips, and read by the palette commands via `useCompactMode`.
 */

let active = false;
const listeners = new Set<() => void>();

export function setCompactModeActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): boolean {
  return active;
}

/** Read "is compact mode active" reactively in any component. */
export function useCompactMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Non-reactive read (useful inside handlers / factories). */
export function isCompactModeActive(): boolean {
  return active;
}
