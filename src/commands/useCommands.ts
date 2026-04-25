import { useEffect, useRef } from 'react';
import { setBucket } from './registry';
import type { Command } from './types';

let nextBucketId = 0;
const genBucketId = () => `cmds:${++nextBucketId}`;

/**
 * Contribute commands from a feature hook/component.
 *
 * Colocate this next to the feature's handlers. Commands are registered
 * into a global registry and surfaced by the Cmd+K palette.
 *
 * ```tsx
 * const { handleRestartDevServer, stopServer, isServerRunning } = useDevServer();
 *
 * useCommands(
 *   () => [
 *     {
 *       id: 'devserver.restart',
 *       title: 'Restart dev server',
 *       category: 'action',
 *       when: 'project',
 *       run: handleRestartDevServer,
 *     },
 *     {
 *       id: 'devserver.stop',
 *       title: 'Stop dev server',
 *       category: 'action',
 *       when: ({ kind }) => kind === 'project' && isServerRunning,
 *       run: stopServer,
 *     },
 *   ],
 *   [handleRestartDevServer, stopServer, isServerRunning],
 * );
 * ```
 *
 * Semantics:
 *  - Factory runs when `deps` change; result replaces the bucket.
 *  - Unmount clears the bucket automatically.
 *  - Errors thrown from the factory are surfaced via console.error.
 */
export function useCommands(factory: () => Command[], deps: unknown[]): void {
  const bucketIdRef = useRef<string | null>(null);
  if (bucketIdRef.current === null) {
    bucketIdRef.current = genBucketId();
  }

  useEffect(() => {
    const id = bucketIdRef.current!;
    try {
      setBucket(id, factory());
    } catch (err) {
      // A bad command factory shouldn't take down the feature — log and
      // leave the previous bucket in place so the palette stays usable.

      console.error('[useCommands] factory threw', err);
    }
    return () => setBucket(id, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the public API
  }, deps);
}
