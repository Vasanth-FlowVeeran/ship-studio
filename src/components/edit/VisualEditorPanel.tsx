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
import { EnumDropdown } from './EnumDropdown';
import { MultiSourceControl } from './MultiSourceControl';
import { UsageScope } from './UsageScope';
import { CodeIcon } from './CodeIcon';
import { PropSection } from './PropSection';
import { PropControlRenderer, type ControlRenderCtx } from './PropControlRenderer';
import { CONTROL_SECTIONS } from '../../lib/editControls';
import { breakpointPrefixes, type UsageReport } from '../../lib/edit';
import type {
  BoxType,
  Side,
  Breakpoint,
  LayerContext,
  SpacingValue,
  ResetSpec,
} from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

/** Save-status badge — the SAME box whether saving or saved, so the footer never
 *  shifts height between the two (auto-save) states. */
function StatusBadge({ saving }: { saving: boolean }) {
  return (
    <div className="ss-edit-panel__saved" aria-live="polite">
      {saving ? (
        'Saving…'
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

/** Small "?" glyph that reveals a custom tooltip on hover/focus. */
function HelpHint({ text }: { text: string }) {
  return (
    <span className="ss-edit-panel__help" tabIndex={0} role="img" aria-label={text}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M5.8 6.2c0-1.2 1-2 2.2-2s2.2.8 2.2 2c0 .8-.5 1.3-1.1 1.6-.6.4-1.1.7-1.1 1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
      </svg>
      <span className="ss-edit-panel__help-tip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

/** Empty-state intro shown before any element is selected — explains what the
 *  visual editor is and how it works, instead of a bare one-line hint. */
function IntroCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditorIntro() {
  return (
    <div className="ss-edit-intro">
      <p className="ss-edit-intro__lead">
        Click any element to fine-tune its Tailwind styles — spacing, size, type, color, layout, and
        more — without using any tokens. Double-click text to edit the copy right on the page.
      </p>
      <ul className="ss-edit-intro__list">
        <li>
          <IntroCheck />
          <span>
            Works with any <strong>Next.js</strong> or <strong>Astro</strong> project that uses
            Tailwind
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>
            Edit styles and text — <strong>double-click</strong> to rewrite text, bold, italic, or
            link it
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>
            Free — uses <strong>0 tokens</strong>
          </span>
        </li>
        <li>
          <IntroCheck />
          <span>Updates live and saves to your source instantly</span>
        </li>
      </ul>
    </div>
  );
}

/** Subtle info dot shown by the source line when the element is styled by a custom
 *  CSS class — its tooltip explains that edits use `!important` to win the cascade. */
function CustomCssHint() {
  return (
    <span
      className="ss-edit-panel__csshint"
      tabIndex={0}
      role="img"
      aria-label="Styled by a custom CSS class — edits use !important so they take effect"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="4.6" r="0.8" fill="currentColor" />
        <path
          d="M8 7v4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="ss-edit-panel__csshint-tip" role="tooltip">
        Styled by a custom CSS class — edits use <code>!important</code> so they take effect.
      </span>
    </span>
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
  /** Whether edits auto-save to source (debounced). */
  autoSave: boolean;
  /** Toggle auto-save on/off. */
  onToggleAutoSave: () => void;
  /** Step the gap utility one notch up (1) or down (-1). */
  onStepGap: (dir: 1 | -1) => void;
  /** Set one side of padding/margin to a scale step or arbitrary value. */
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
  /** Apply an enum option's token + inline-style preview. */
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  /** Reset a control's value at the active breakpoint. */
  onReset: (spec: ResetSpec) => void;
  /** For a multi-location element: which spot(s) to write — 'all' or one index. */
  multiTarget: 'all' | number;
  onMultiTargetChange: (t: 'all' | number) => void;
  /** Where the selected element's component is used project-wide (scope hint). */
  usage: UsageReport | null;
  /** Jump to a source file:line in the Code tab. */
  onOpenInCode?: (file: string, line: number) => void;
  onCommit: () => void;
  onClose: () => void;
}

const PANEL_WIDTH = 264;

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
  autoSave,
  onToggleAutoSave,
  onStepGap,
  onSetSide,
  onApplyEnum,
  onReset,
  multiTarget,
  onMultiTargetChange,
  usage,
  onOpenInCode,
  onCommit,
  onClose,
}: Props) {
  const resolution = selection?.resolution ?? null;
  // Both 'resolved' (one spot) and 'multi' (several identical spots) are editable.
  const editable = resolution?.status === 'resolved' || resolution?.status === 'multi';
  const dirty = editable && currentClass !== resolution.class_name;
  // Show the controls as soon as an element is selected — they only need the class
  // string (available instantly). The source badge + Save fill in once resolved, so
  // the panel doesn't flicker through a "Resolving…" collapse on every click.
  const controlsVisible = !!selection && resolution?.status !== 'read_only';

  // Cascade-resolution context for the active breakpoint, threaded to each control
  // so they show the effective value at this layer and which breakpoint set it.
  const layer = useMemo<LayerContext>(
    () => ({ bp: activeBreakpoint, ordered: breakpoints, known: breakpointPrefixes(breakpoints) }),
    [activeBreakpoint, breakpoints]
  );

  // Shared render context for every control row (the registry renders generically).
  const controlCtx = useMemo<ControlRenderCtx>(
    () => ({
      currentClass,
      layer,
      onApplyEnum,
      onReset,
      onSetSide,
      onStepGap,
      computed: {
        color: selection?.signature.computedColor,
        'background-color': selection?.signature.computedBackgroundColor,
      },
    }),
    [currentClass, layer, onApplyEnum, onReset, onSetSide, onStepGap, selection]
  );

  // Contextual mobile-first explainer (shown in the "?" tooltip by the label).
  const breakpointHelp =
    activeBreakpoint.minPx > 0
      ? `Changes here apply from ${activeBreakpoint.minPx}px wide and up, overriding the smaller sizes.`
      : 'Changes here apply to every screen size. Pick a breakpoint to override it from that width up.';

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
        {controlsVisible && (
          <>
            {/* Breakpoint dropdown — picking one resizes the canvas; the active value
                tracks the live preview width. Tailwind is mobile-first: edits cascade
                up, so a value set on a breakpoint applies at that width and larger. */}
            <div className="ss-edit-panel__control">
              {/* The "?" reveals the mobile-first explainer — styles set on a breakpoint
                  apply at that width AND LARGER, which surprises desktop-first users. */}
              <label className="ss-edit-panel__label">
                Breakpoint
                <HelpHint text={breakpointHelp} />
              </label>
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

            {breakpointTooWide && (
              <p className="ss-edit-panel__bp-note" role="note">
                Preview is too narrow to show <strong>{activeBreakpoint.name}</strong> (≥
                {activeBreakpoint.minPx}px). Edits still apply at this breakpoint — widen the
                preview to see them.
              </p>
            )}
          </>
        )}

        {!selection && <EditorIntro />}

        {resolution?.status === 'read_only' && (
          <p className="ss-edit-panel__readonly">{resolution.reason}</p>
        )}

        {controlsVisible && (
          <>
            {resolution?.status === 'resolved' && (
              <>
                <div className="ss-edit-panel__source">
                  {onOpenInCode ? (
                    <button
                      type="button"
                      className="ss-edit-panel__srclink"
                      title="Open in the Code tab"
                      onClick={() => onOpenInCode(resolution.file, resolution.line)}
                    >
                      <code>
                        {resolution.file}:{resolution.line}
                      </code>
                      <CodeIcon size={12} />
                    </button>
                  ) : (
                    <code>
                      {resolution.file}:{resolution.line}
                    </code>
                  )}
                  {resolution.confidence !== 'unique' && (
                    <span
                      className="ss-edit-panel__badge ss-edit-panel__badge--approx"
                      title="These classes appear more than once in your code, so the source was located by surrounding context — double-check before saving."
                    >
                      approx.
                    </span>
                  )}
                  {(selection?.signature.unlayeredProps?.length ?? 0) > 0 && <CustomCssHint />}
                </div>

                {selection && selection.instanceCount > 1 && (
                  <p className="ss-edit-panel__multi">
                    Editing {selection.instanceCount} elements that share this source
                  </p>
                )}
                <UsageScope
                  usage={usage}
                  instanceCount={selection?.instanceCount ?? 1}
                  onOpenInCode={onOpenInCode}
                />
              </>
            )}
            {resolution?.status === 'multi' && (
              <MultiSourceControl
                locations={resolution.locations}
                target={multiTarget}
                onChange={onMultiTargetChange}
              />
            )}

            {CONTROL_SECTIONS.map((section) => (
              <PropSection key={section.id} title={section.title} defaultOpen={section.defaultOpen}>
                {section.controls.map((control) => (
                  <PropControlRenderer key={control.key} control={control} ctx={controlCtx} />
                ))}
              </PropSection>
            ))}

            <div className="ss-edit-panel__classes" title={currentClass}>
              {currentClass}
            </div>
          </>
        )}

        <p className="ss-edit-panel__beta">
          <strong>
            Visual editor is in beta. Style editing works best with Next.js; text editing works the
            same on Next.js and Astro.
          </strong>{' '}
          Hit a bug or have feedback? We'd genuinely appreciate hearing about it.
        </p>
      </div>

      {controlsVisible && (
        <div className="ss-edit-panel__footer">
          <button
            type="button"
            role="switch"
            aria-checked={autoSave}
            className="ss-edit-panel__autosave"
            onClick={onToggleAutoSave}
            title="Automatically save edits to source as you go"
          >
            <span className={`ss-edit-panel__switch${autoSave ? ' is-on' : ''}`} aria-hidden />
            Auto-save
          </button>
          {!editable ? (
            // Resolving the source location — Save isn't available yet.
            <span className="ss-edit-panel__locating">Locating source…</span>
          ) : autoSave ? (
            <StatusBadge saving={dirty} />
          ) : dirty ? (
            <Button size="sm" variant="primary" onClick={onCommit}>
              Save to source
            </Button>
          ) : (
            <StatusBadge saving={false} />
          )}
        </div>
      )}
    </div>
  );
}
