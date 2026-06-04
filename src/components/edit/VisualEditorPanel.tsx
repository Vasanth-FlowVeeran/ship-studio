/**
 * Visual editor properties panel.
 *
 * Renders for the element selected in the preview and exposes the spacing
 * controls (padding / margin / gap) as live steppers: each step mutates the DOM
 * instantly and persists to source on "Save". Ambiguous/dynamic elements are
 * shown read-only with the reason, matching the resolver's safe fallback.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '../primitives/Button';
import { SpacingBox } from './SpacingBox';
import { EnumControls } from './EnumControls';
import { EnumDropdown } from './EnumDropdown';
import { ColorControls } from './ColorControls';
import { LayerDot } from './LayerDot';
import {
  scaleValue,
  readLayer,
  breakpointPrefixes,
  SPACING_REM,
  type BoxType,
  type Side,
  type Breakpoint,
  type LayerContext,
} from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

/** Editable numeric field for the gap value: click to type, Enter/blur to apply,
 *  stays in sync when the +/- steppers change the value externally (synced during
 *  render via the prev-value pattern — no effect). */
function GapField({ value, onSet }: { value: number | null; onSet: (n: number) => void }) {
  const display = value?.toString() ?? '';
  const [text, setText] = useState(display);
  const [lastDisplay, setLastDisplay] = useState(display);
  if (display !== lastDisplay) {
    setLastDisplay(display);
    setText(display);
  }

  const commit = () => {
    const n = parseInt(text, 10);
    if (!Number.isNaN(n) && n >= 0) onSet(n);
    else setText(value?.toString() ?? '');
  };

  return (
    <input
      className="ss-edit-panel__num"
      inputMode="numeric"
      aria-label="Gap"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface Props {
  selection: Selection | null;
  /** The class string currently applied live (what "Save" will persist). */
  currentClass: string;
  /** All breakpoints (Base + detected), ascending by min-width. */
  breakpoints: Breakpoint[];
  /** The breakpoint layer currently being edited (derived from the canvas width). */
  activeBreakpoint: Breakpoint;
  /** True when the active breakpoint is wider than the preview can show — edits
   *  apply but aren't visible at the current canvas size. */
  breakpointTooWide: boolean;
  /** Switch the edited breakpoint — resizes the preview canvas to match. */
  onSelectBreakpoint: (bp: Breakpoint) => void;
  /** Step the gap utility one notch up (1) or down (-1). */
  onStepGap: (dir: 1 | -1) => void;
  /** Set one side of padding/margin to an absolute value (box-model editor). */
  onSetSide: (type: BoxType, side: Side, n: number) => void;
  /** Apply an enum option's token + inline-style preview. */
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onCommit: () => void;
  onClose: () => void;
}

const PANEL_WIDTH = 240;

/** Initial top-right resting spot (clears the toolbar). Lazy so it reads the
 *  window once on mount; drag takes over from there. */
function initialPos() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return { top: 96, left: Math.max(16, w - PANEL_WIDTH - 16) };
}

export function VisualEditorPanel({
  selection,
  currentClass,
  breakpoints,
  activeBreakpoint,
  breakpointTooWide,
  onSelectBreakpoint,
  onStepGap,
  onSetSide,
  onApplyEnum,
  onCommit,
  onClose,
}: Props) {
  const resolution = selection?.resolution ?? null;
  const dirty = resolution?.status === 'resolved' && currentClass !== resolution.class_name;

  // Cascade-resolution context for the active breakpoint, threaded to each control
  // so they show the effective value at this layer and which breakpoint set it.
  const layer = useMemo<LayerContext>(
    () => ({ bp: activeBreakpoint, ordered: breakpoints, known: breakpointPrefixes(breakpoints) }),
    [activeBreakpoint, breakpoints]
  );
  const gap = readLayer(currentClass, layer, (s) => scaleValue(s, 'gap'));
  const opacity = readLayer(currentClass, layer, (s) => scaleValue(s, 'opacity'));

  // Self-owned fixed position so the panel is draggable by its header. Fully
  // inline (no CSS-var/measurement dependency) so it can't drift out of view.
  const [pos, setPos] = useState(initialPos);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Don't start a drag from the close button.
    if ((e.target as HTMLElement).closest('.ss-edit-panel__close')) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onHeaderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = rootRef.current?.offsetWidth ?? PANEL_WIDTH;
    const left = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - 40));
    setPos({ top, left });
  }, []);

  const onHeaderPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <div
      ref={rootRef}
      className="ss-edit-panel"
      data-testid="visual-editor-panel"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        right: 'auto',
        zIndex: 1000,
        // Cap shorter than the viewport; the body scrolls, the footer stays put.
        maxHeight: `min(520px, calc(100vh - ${pos.top + 16}px))`,
      }}
    >
      <div
        className="ss-edit-panel__header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span className="ss-edit-panel__title">Edit</span>
        <button className="ss-edit-panel__close" onClick={onClose} aria-label="Exit edit mode">
          ×
        </button>
      </div>

      <div className="ss-edit-panel__body">
        {/* Breakpoint dropdown — picking one resizes the canvas; the active value
            tracks the live preview width. Tailwind is mobile-first: edits cascade
            up, so a value set on a breakpoint applies at that width and larger. */}
        <div className="ss-edit-panel__control">
          <label className="ss-edit-panel__label">Breakpoint</label>
          <EnumDropdown
            label="Breakpoint"
            value={activeBreakpoint.name}
            options={breakpoints.map((bp) => ({
              label: bp.minPx > 0 ? `${bp.name} · ≥${bp.minPx}px` : 'Base · all widths',
              token: bp.name,
            }))}
            onChange={(name) => {
              const bp = breakpoints.find((b) => b.name === name);
              if (bp) onSelectBreakpoint(bp);
            }}
          />
        </div>

        {/* Plain-language explainer of the mobile-first cascade — styles set on a
            breakpoint apply at that width AND LARGER, which surprises users coming
            from desktop-first tools. Contextual to the active layer. */}
        <p className="ss-edit-panel__bp-help">
          {activeBreakpoint.minPx > 0
            ? `Changes here apply from ${activeBreakpoint.minPx}px wide and up, overriding the smaller sizes.`
            : 'Changes here apply to every screen size. Pick a breakpoint to override it from that width up.'}
        </p>

        {breakpointTooWide && (
          <p className="ss-edit-panel__bp-note" role="note">
            Preview is too narrow to show <strong>{activeBreakpoint.name}</strong> (≥
            {activeBreakpoint.minPx}px). Edits still apply at this breakpoint — widen the preview to
            see them.
          </p>
        )}

        {!selection && (
          <p className="ss-edit-panel__hint">
            Click any element in the preview to edit its spacing.
          </p>
        )}

        {selection && !resolution && <p className="ss-edit-panel__hint">Resolving source…</p>}

        {resolution?.status === 'read_only' && (
          <p className="ss-edit-panel__readonly">{resolution.reason}</p>
        )}

        {resolution?.status === 'ambiguous' && (
          <p className="ss-edit-panel__readonly">
            {resolution.reason}
            <br />
            <span className="ss-edit-panel__muted">
              {resolution.candidate_count} possible locations
            </span>
          </p>
        )}

        {resolution?.status === 'resolved' && (
          <>
            <div className="ss-edit-panel__source">
              <code>
                {resolution.file}:{resolution.line}
              </code>
              {resolution.confidence !== 'unique' && (
                <span
                  className="ss-edit-panel__badge ss-edit-panel__badge--approx"
                  title="These classes appear more than once in your code, so the source was located by surrounding context — double-check before saving."
                >
                  approx.
                </span>
              )}
            </div>

            {selection && selection.instanceCount > 1 && (
              <p className="ss-edit-panel__multi">
                Editing {selection.instanceCount} elements that share this source
              </p>
            )}

            <SpacingBox currentClass={currentClass} layer={layer} onSetSide={onSetSide} />

            <div className="ss-edit-panel__control">
              <label className="ss-edit-panel__label">
                Gap
                <LayerDot definedAt={gap.definedAt} active={activeBreakpoint} />
              </label>
              <div className="ss-edit-panel__stepper">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Decrease gap"
                  onClick={() => onStepGap(-1)}
                >
                  −
                </Button>
                <GapField
                  value={gap.value}
                  onSet={(n) => onApplyEnum(`gap-${n}`, { gap: `${n * SPACING_REM}rem` })}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Increase gap"
                  onClick={() => onStepGap(1)}
                >
                  ＋
                </Button>
              </div>
            </div>

            <EnumControls currentClass={currentClass} layer={layer} onApplyEnum={onApplyEnum} />

            <div className="ss-edit-panel__control">
              <label className="ss-edit-panel__label">
                Opacity
                <LayerDot definedAt={opacity.definedAt} active={activeBreakpoint} />
              </label>
              <input
                type="range"
                className="ss-edit-panel__slider"
                aria-label="Opacity"
                min={0}
                max={100}
                step={5}
                value={opacity.value ?? 100}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onApplyEnum(`opacity-${n}`, { opacity: String(n / 100) });
                }}
              />
            </div>

            <ColorControls
              currentClass={currentClass}
              layer={layer}
              onApplyEnum={onApplyEnum}
              computed={{
                color: selection?.signature.computedColor,
                'background-color': selection?.signature.computedBackgroundColor,
              }}
            />

            <div className="ss-edit-panel__classes" title={currentClass}>
              {currentClass}
            </div>
          </>
        )}
      </div>

      {resolution?.status === 'resolved' && (
        <div className="ss-edit-panel__footer">
          {dirty ? (
            <Button size="sm" variant="primary" block onClick={onCommit}>
              Save to source
            </Button>
          ) : (
            <div className="ss-edit-panel__saved" aria-live="polite">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Saved
            </div>
          )}
        </div>
      )}
    </div>
  );
}
