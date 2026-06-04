/**
 * Visual editor controller.
 *
 * Owns edit-mode state and the message bridge to the in-iframe selection script
 * (`SELECT_SCRIPT` in `src-tauri/src/proxy/mod.rs`):
 *  - toggling edit mode posts `ss:activate` / `ss:deactivate`
 *  - incoming `ss:select` messages are resolved to a source location
 *  - `previewClass` posts `ss:mutate` for instant DOM feedback (no write)
 *  - `commit` writes the merged className back to source via the backend
 *
 * The selection script re-initializes inert on every (HMR) reload, so we
 * re-post `ss:activate` on each iframe `load` while edit mode is on.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  steppedScale,
  scaleValue,
  boxSideToken,
  boxSideValue,
  withVariant,
  tokensForVariant,
  breakpointPrefixes,
  SPACING_CONTROLS,
  SPACING_REM,
  type SpacingKind,
  type BoxType,
  type Side,
  type Breakpoint,
  type ElementSignature,
  type Resolution,
} from '../lib/edit';
import { logger } from '../lib/logger';

/** A breakpoint-scoped slice of the live-preview stylesheet: `decls` applied at
 *  `minPx` and up (0 = base, all widths). Mirrors `select_script.html`'s contract. */
interface PreviewRule {
  minPx: number;
  decls: Record<string, string>;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Feature availability (e.g. Next.js project + server ready). */
  enabled: boolean;
  /** The breakpoint layer edits target (Base = unprefixed). Drives the variant
   *  prefix on written tokens and the min-width of the live-preview rule. */
  activeBreakpoint: Breakpoint;
  /** All breakpoints (incl. Base) — used to recognize/strip variant prefixes. */
  breakpoints: Breakpoint[];
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export interface Selection {
  signature: ElementSignature;
  /** null while the backend resolve is in flight. */
  resolution: Resolution | null;
  /** How many elements on the page share these exact classes (same source ⇒ a
   *  save updates all of them). 1 for a unique element. */
  instanceCount: number;
}

export function useVisualEditor({
  iframeRef,
  projectPath,
  enabled,
  activeBreakpoint,
  breakpoints,
  onToast,
}: Params) {
  // User intent; the *effective* mode below also requires the feature be enabled,
  // so it flips off automatically when the server restarts (no reset effect).
  const [editModeOn, setEditModeOn] = useState(false);
  const editMode = enabled && editModeOn;

  // Known breakpoint prefixes, for scoping a class string to one variant layer.
  const known = useMemo(() => breakpointPrefixes(breakpoints), [breakpoints]);

  const [selection, setSelection] = useState<Selection | null>(null);
  /** The class string currently applied live in the iframe (merge baseline). */
  const [currentClass, setCurrentClass] = useState('');
  // Mirror into a ref so `applyToken`/`commit` callbacks read the latest value
  // without re-subscribing. Written only through `setLiveClass` (never in render).
  const currentClassRef = useRef('');
  const setLiveClass = useCallback((value: string) => {
    currentClassRef.current = value;
    setCurrentClass(value);
  }, []);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Activate/deactivate the in-iframe selection layer (external-system sync), and
  // keep it active across HMR reloads (each reload resets the script to inert).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (editMode) {
      post({ type: 'ss:activate' });
      const reactivate = () => post({ type: 'ss:activate' });
      iframe?.addEventListener('load', reactivate);
      return () => iframe?.removeEventListener('load', reactivate);
    }
    post({ type: 'ss:deactivate' });
  }, [editMode, post, iframeRef]);

  // Resolve clicked elements.
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      const d = e.data as { type?: string; signature?: ElementSignature; count?: number } | null;
      if (!d || d.type !== 'ss:select' || !d.signature) return;
      const sig = d.signature;
      const instanceCount = d.count ?? 1;
      setSelection({ signature: sig, resolution: null, instanceCount });
      setLiveClass(sig.className);
      void (async () => {
        try {
          const resolution = await resolveClassnameSource(projectPath, sig);
          setSelection({ signature: sig, resolution, instanceCount });
        } catch (err) {
          logger.error('[VisualEditor] resolve failed', { error: String(err) });
          onToast?.(String(err), 'error');
          setSelection({
            signature: sig,
            resolution: {
              status: 'read_only',
              reason: 'Could not resolve this element to source.',
            },
            instanceCount,
          });
        }
      })();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [editMode, projectPath, onToast, setLiveClass]);

  /**
   * Merge a Tailwind token into the live class at the active breakpoint and
   * preview it (no write). `token` is the BARE (unprefixed) utility — we add the
   * active breakpoint's variant prefix here, so callers stay breakpoint-agnostic.
   *
   * `style` is the CSS the token resolves to, sent as a breakpoint-scoped preview
   * rule. It exists because Tailwind's JIT only emits CSS for classes found in
   * source — a freshly-typed `md:p-14` has no compiled rule, so the class alone
   * shows nothing until saved. The rule (at the breakpoint's min-width) drives a
   * truthful preview: a `md:` edit only shows ≥768px, unlike an inline style.
   */
  const applyToken = useCallback(
    (token: string, style?: Record<string, string>) => {
      const merged = twMerge(currentClassRef.current, withVariant(activeBreakpoint.prefix, token));
      setLiveClass(merged);
      const rules: PreviewRule[] = style ? [{ minPx: activeBreakpoint.minPx, decls: style }] : [];
      post({ type: 'ss:mutate', className: merged, rules });
    },
    [post, setLiveClass, activeBreakpoint]
  );

  /** Set one side of a box (padding/margin) at the active breakpoint. Previews
   *  only the sides this layer actually defines (so unset sides fall through to
   *  the real, already-compiled base CSS rather than being forced to 0). */
  const setBoxSide = useCallback(
    (type: BoxType, side: Side, n: number) => {
      const merged = twMerge(
        currentClassRef.current,
        withVariant(activeBreakpoint.prefix, boxSideToken(type, side, n))
      );
      setLiveClass(merged);
      const scoped = tokensForVariant(merged, activeBreakpoint.prefix, known);
      const decls: Record<string, string> = {};
      for (const s of ['top', 'right', 'bottom', 'left'] as Side[]) {
        const v = boxSideValue(scoped, type, s);
        if (v !== null) decls[`${type}-${s}`] = `${v * SPACING_REM}rem`;
      }
      post({
        type: 'ss:mutate',
        className: merged,
        rules: [{ minPx: activeBreakpoint.minPx, decls }],
      });
    },
    [post, setLiveClass, activeBreakpoint, known]
  );

  /** Step a spacing utility (padding/margin/gap) by one integer at the active
   *  breakpoint, computed from that layer's current value (so stepping `md:` reads
   *  the md value, not base). Drives a breakpoint-scoped preview rule (Tailwind
   *  spacing = N × 0.25rem) so it shows even before Tailwind compiles the class. */
  const stepSpacing = useCallback(
    (kind: SpacingKind, dir: 1 | -1) => {
      const ctrl = SPACING_CONTROLS.find((c) => c.kind === kind);
      if (!ctrl) return;
      const scoped = tokensForVariant(currentClassRef.current, activeBreakpoint.prefix, known);
      const token = steppedScale(scoped, ctrl.prefix, dir);
      const n = scaleValue(token, ctrl.prefix) ?? 0;
      applyToken(token, { [ctrl.css]: `${n * SPACING_REM}rem` });
    },
    [applyToken, activeBreakpoint, known]
  );

  /** Persist the current live class to source. */
  const commit = useCallback(async () => {
    const sel = selection;
    if (!sel || sel.resolution?.status !== 'resolved') return;
    const next = currentClassRef.current;
    const { file, line, class_name } = sel.resolution;
    if (next === class_name) return; // nothing changed
    try {
      await applyClassnameEdit(projectPath, file, line, class_name, next);
      // Advance the drift baseline so consecutive edits keep working.
      setSelection({ ...sel, resolution: { ...sel.resolution, class_name: next } });
      // Tell the in-iframe script this live state is now the saved baseline, so
      // deactivating (closing the panel) doesn't revert the just-saved edit
      // before HMR re-renders it from source.
      post({ type: 'ss:commit' });
      onToast?.('Saved to source', 'success');
    } catch (err) {
      logger.error('[VisualEditor] write-back failed', { error: String(err) });
      onToast?.(String(err), 'error');
    }
  }, [selection, projectPath, onToast, post]);

  const toggleEditMode = useCallback(() => {
    setEditModeOn((prev) => {
      // Turning off: clear the current selection (event-handler context, so
      // these state updates batch without a cascading-render effect).
      if (prev) {
        setSelection(null);
        setLiveClass('');
      }
      return !prev;
    });
  }, [setLiveClass]);

  return {
    editMode,
    toggleEditMode,
    selection,
    currentClass,
    stepSpacing,
    setBoxSide,
    // Enum controls apply an absolute token (twMerge swaps the prior one) plus an
    // inline-style preview — same path as spacing, just not relative to a scale.
    applyEnum: applyToken,
    commit,
  };
}
