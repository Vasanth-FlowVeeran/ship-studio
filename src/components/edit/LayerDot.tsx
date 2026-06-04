/**
 * Tiny indicator that shows whether a control's value is set on the active
 * breakpoint or inherited from a smaller one (Tailwind's min-width cascade).
 * Driven by `definedAt` from `readLayer`/`resolveCascade`.
 */

import { type Breakpoint } from '../../lib/edit';

interface Props {
  /** Where the effective value came from, or null when unset/default. */
  definedAt: Breakpoint | null;
  /** The breakpoint currently being edited. */
  active: Breakpoint;
}

export function LayerDot({ definedAt, active }: Props) {
  if (!definedAt) return null; // unset → no indicator
  const here = definedAt.name === active.name;
  return (
    <span
      className={`ss-layer-dot${here ? ' ss-layer-dot--here' : ' ss-layer-dot--inherited'}`}
      title={here ? `Set on ${active.name}` : `Inherited from ${definedAt.name}`}
      aria-label={here ? `Set on ${active.name}` : `Inherited from ${definedAt.name}`}
    />
  );
}
