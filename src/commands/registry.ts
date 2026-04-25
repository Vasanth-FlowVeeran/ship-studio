import type { Command } from './types';

/**
 * Module-level command registry. Each feature hook owns a bucket of
 * commands (keyed by a stable `useCommands` id) and the registry
 * publishes a merged snapshot via subscribe/getSnapshot so the palette
 * can consume it through useSyncExternalStore without re-render storms.
 */

const buckets = new Map<string, Command[]>();
const listeners = new Set<() => void>();

/** Cached merged snapshot — invalidated on every setBucket. */
let cachedSnapshot: Command[] = [];

function rebuild() {
  cachedSnapshot = Array.from(buckets.values()).flat();
}

function notify() {
  for (const fn of listeners) fn();
}

/** Replace (or clear) a bucket. Pass `[]` to unregister. */
export function setBucket(key: string, commands: Command[]): void {
  if (commands.length === 0) {
    if (!buckets.has(key)) return;
    buckets.delete(key);
  } else {
    buckets.set(key, commands);
  }
  rebuild();
  notify();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Stable reference — useSyncExternalStore requires identity stability. */
export function getSnapshot(): Command[] {
  return cachedSnapshot;
}

/** Test helper: drop all buckets + listeners. */
export function _reset(): void {
  buckets.clear();
  listeners.clear();
  cachedSnapshot = [];
}
