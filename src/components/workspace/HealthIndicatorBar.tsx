/**
 * HealthIndicatorBar — wraps CodeHealthPanel. Previously also owned a
 * right-side toolbar with preview-restore / compact-mode / browser
 * controls, but those moved into the full-width `.preview-tabs-bar`
 * at the workspace-main level, so they stay reachable even when the
 * preview pane is hidden. This component now purely renders (or hides)
 * the code-health UI.
 *
 * ────────────────────────────────────────────────────────────────────
 * EXPERIMENT (hidden on purpose): the Health panel UI is currently
 * disabled via `HEALTH_PANEL_VISIBLE` below. We want to see whether
 * anyone actually notices it's gone before committing to removing
 * the feature. If support pings come in about missing test/lint/
 * typecheck indicators, flip the flag back to `true`. All underlying
 * code (CodeHealthPanel, useCodeHealth, healthPanelRef plumbing,
 * auto-run on branch switch via useBranchManagement) is intentionally
 * left intact — we're only hiding the UI.
 * ────────────────────────────────────────────────────────────────────
 *
 * @module components/workspace/HealthIndicatorBar
 */

import type { RefObject } from 'react';
import { CodeHealthPanel } from '../CodeHealthPanel';
import type { CodeHealthPanelRef } from '../CodeHealthPanel';

/**
 * Feature flag for the Health panel UI. Flip to `true` to restore the
 * test/lint/typecheck/format indicator + expandable detail panel. See
 * the module comment above for the rationale.
 */
const HEALTH_PANEL_VISIBLE = false;

export interface HealthIndicatorBarProps {
  projectPath: string;
  healthPanelRef: RefObject<CodeHealthPanelRef | null>;
  onAskClaude: (text: string) => void;
  onHealthOutput: (data: string) => void;
}

export function HealthIndicatorBar({
  projectPath,
  healthPanelRef,
  onAskClaude,
  onHealthOutput,
}: HealthIndicatorBarProps) {
  if (!HEALTH_PANEL_VISIBLE) {
    // Hidden-experiment path: skip CodeHealthPanel entirely. The
    // preview-hide/show toggle now lives in the full-width tabs bar at
    // workspace-main scope, so we don't need to keep a fallback toolbar
    // row here. `healthPanelRef` stays un-populated; the only external
    // callers (useBranchManagement's post-switch auto-run) use optional
    // chaining, so the calls become no-ops.
    return null;
  }

  return (
    <CodeHealthPanel
      ref={healthPanelRef}
      projectPath={projectPath}
      onAskClaude={onAskClaude}
      onHealthOutput={onHealthOutput}
    />
  );
}
