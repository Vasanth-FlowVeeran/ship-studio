/**
 * Structured control schema for the CSS-Mode editor (Phase 4).
 *
 * Unlike the Tailwind editor — which maps controls onto utility tokens and a
 * cross-breakpoint cascade — CSS mode reads/writes a property straight off the
 * resolved rule's declarations. So a control is just `{ a CSS property, how to
 * render it }`, and the value is `declarations.find(d => d.property === prop)`.
 *
 * The "Custom" category is handled by the panel directly (the raw declaration
 * list), so any property is always editable even if no structured control
 * exists for it.
 */

import type { CssDeclaration } from './edit-css';

/** Read the current value of a CSS property from a rule's declarations. */
export function cssValueOf(declarations: CssDeclaration[], prop: string): string {
  const lc = prop.toLowerCase();
  return declarations.find((d) => d.property.toLowerCase() === lc)?.value ?? '';
}

/** Predicate over the current declarations (for conditional controls). */
export type ControlPredicate = (get: (prop: string) => string) => boolean;

interface BaseControl {
  prop: string;
  label: string;
  /** Only render when this returns true (e.g. flex controls when display:flex). */
  showIf?: ControlPredicate;
}

export interface SegOption {
  value: string;
  /** Short text shown on the segment (omit when using `glyph`). */
  label?: string;
  /** A compact glyph (e.g. an arrow) shown instead of a label. */
  glyph?: string;
  /** Accessible / hover title. */
  title?: string;
}

export type CssControl =
  | (BaseControl & { kind: 'segmented'; options: SegOption[] })
  | (BaseControl & { kind: 'select'; options: { value: string; label: string }[] })
  | (BaseControl & { kind: 'length'; placeholder?: string })
  | (BaseControl & { kind: 'color' });

export interface CssCategory {
  id: string;
  label: string;
  /** Controls for the category; `custom` has none (the panel renders the list). */
  controls: CssControl[];
}

const isFlexish: ControlPredicate = (get) => {
  const d = get('display');
  return d.includes('flex') || d.includes('grid');
};
const isFlex: ControlPredicate = (get) => get('display').includes('flex');
const isPositioned: ControlPredicate = (get) => {
  const p = get('position');
  return p !== '' && p !== 'static';
};

export const CSS_CATEGORIES: CssCategory[] = [
  {
    id: 'layout',
    label: 'Layout',
    controls: [
      {
        kind: 'segmented',
        prop: 'display',
        label: 'Display',
        options: [
          { value: 'block', label: 'Block' },
          { value: 'flex', label: 'Flex' },
          { value: 'grid', label: 'Grid' },
          { value: 'inline-block', label: 'Inline' },
          { value: 'none', label: 'None' },
        ],
      },
      {
        kind: 'segmented',
        prop: 'flex-direction',
        label: 'Direction',
        showIf: isFlex,
        options: [
          { value: 'row', glyph: '→', title: 'Row' },
          { value: 'column', glyph: '↓', title: 'Column' },
          { value: 'row-reverse', glyph: '←', title: 'Row reverse' },
          { value: 'column-reverse', glyph: '↑', title: 'Column reverse' },
        ],
      },
      {
        kind: 'segmented',
        prop: 'align-items',
        label: 'Align items',
        showIf: isFlexish,
        options: [
          { value: 'flex-start', label: 'Start' },
          { value: 'center', label: 'Center' },
          { value: 'flex-end', label: 'End' },
          { value: 'stretch', label: 'Stretch' },
        ],
      },
      {
        kind: 'segmented',
        prop: 'justify-content',
        label: 'Justify',
        showIf: isFlexish,
        options: [
          { value: 'flex-start', label: 'Start' },
          { value: 'center', label: 'Center' },
          { value: 'flex-end', label: 'End' },
          { value: 'space-between', label: 'Between' },
        ],
      },
      {
        kind: 'segmented',
        prop: 'flex-wrap',
        label: 'Wrap',
        showIf: isFlex,
        options: [
          { value: 'nowrap', label: 'No wrap' },
          { value: 'wrap', label: 'Wrap' },
          { value: 'wrap-reverse', label: 'Reverse' },
        ],
      },
      { kind: 'length', prop: 'gap', label: 'Gap', placeholder: '0', showIf: isFlexish },
    ],
  },
  {
    id: 'spacing',
    label: 'Spacing',
    controls: [
      { kind: 'length', prop: 'padding', label: 'Padding', placeholder: '0' },
      { kind: 'length', prop: 'margin', label: 'Margin', placeholder: '0' },
    ],
  },
  {
    id: 'size',
    label: 'Size',
    controls: [
      { kind: 'length', prop: 'width', label: 'Width', placeholder: 'auto' },
      { kind: 'length', prop: 'height', label: 'Height', placeholder: 'auto' },
      { kind: 'length', prop: 'max-width', label: 'Max width', placeholder: 'none' },
    ],
  },
  {
    id: 'typography',
    label: 'Type',
    controls: [
      { kind: 'length', prop: 'font-size', label: 'Size', placeholder: '16px' },
      {
        kind: 'select',
        prop: 'font-weight',
        label: 'Weight',
        options: [
          { value: '300', label: 'Light' },
          { value: '400', label: 'Normal' },
          { value: '500', label: 'Medium' },
          { value: '600', label: 'Semibold' },
          { value: '700', label: 'Bold' },
          { value: '800', label: 'Extrabold' },
        ],
      },
      { kind: 'length', prop: 'line-height', label: 'Line height', placeholder: '1.5' },
      {
        kind: 'segmented',
        prop: 'text-align',
        label: 'Align',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
          { value: 'justify', label: 'Justify' },
        ],
      },
      {
        kind: 'select',
        prop: 'text-transform',
        label: 'Transform',
        options: [
          { value: 'none', label: 'None' },
          { value: 'uppercase', label: 'Uppercase' },
          { value: 'lowercase', label: 'Lowercase' },
          { value: 'capitalize', label: 'Capitalize' },
        ],
      },
      { kind: 'color', prop: 'color', label: 'Color' },
    ],
  },
  {
    id: 'background',
    label: 'Background',
    controls: [{ kind: 'color', prop: 'background-color', label: 'Background' }],
  },
  {
    id: 'border',
    label: 'Border',
    controls: [
      { kind: 'length', prop: 'border-width', label: 'Width', placeholder: '0' },
      {
        kind: 'select',
        prop: 'border-style',
        label: 'Style',
        options: [
          { value: 'none', label: 'None' },
          { value: 'solid', label: 'Solid' },
          { value: 'dashed', label: 'Dashed' },
          { value: 'dotted', label: 'Dotted' },
        ],
      },
      { kind: 'color', prop: 'border-color', label: 'Color' },
      { kind: 'length', prop: 'border-radius', label: 'Radius', placeholder: '0' },
    ],
  },
  {
    id: 'position',
    label: 'Position',
    controls: [
      {
        kind: 'select',
        prop: 'position',
        label: 'Position',
        options: [
          { value: 'static', label: 'Static' },
          { value: 'relative', label: 'Relative' },
          { value: 'absolute', label: 'Absolute' },
          { value: 'fixed', label: 'Fixed' },
          { value: 'sticky', label: 'Sticky' },
        ],
      },
      { kind: 'length', prop: 'top', label: 'Top', placeholder: 'auto', showIf: isPositioned },
      { kind: 'length', prop: 'right', label: 'Right', placeholder: 'auto', showIf: isPositioned },
      {
        kind: 'length',
        prop: 'bottom',
        label: 'Bottom',
        placeholder: 'auto',
        showIf: isPositioned,
      },
      { kind: 'length', prop: 'left', label: 'Left', placeholder: 'auto', showIf: isPositioned },
      { kind: 'length', prop: 'z-index', label: 'Z-index', placeholder: 'auto' },
    ],
  },
  {
    id: 'transform',
    label: 'Transform',
    controls: [
      { kind: 'length', prop: 'transform', label: 'Transform', placeholder: 'none' },
      { kind: 'length', prop: 'transform-origin', label: 'Origin', placeholder: 'center' },
      { kind: 'length', prop: 'transition', label: 'Transition', placeholder: 'none' },
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    controls: [
      { kind: 'length', prop: 'opacity', label: 'Opacity', placeholder: '1' },
      { kind: 'length', prop: 'box-shadow', label: 'Box shadow', placeholder: 'none' },
      { kind: 'length', prop: 'filter', label: 'Filter', placeholder: 'none' },
      {
        kind: 'select',
        prop: 'overflow',
        label: 'Overflow',
        options: [
          { value: 'visible', label: 'Visible' },
          { value: 'hidden', label: 'Hidden' },
          { value: 'auto', label: 'Auto' },
          { value: 'scroll', label: 'Scroll' },
        ],
      },
      {
        kind: 'select',
        prop: 'cursor',
        label: 'Cursor',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'default', label: 'Default' },
          { value: 'pointer', label: 'Pointer' },
          { value: 'text', label: 'Text' },
          { value: 'move', label: 'Move' },
          { value: 'not-allowed', label: 'Not allowed' },
        ],
      },
    ],
  },
  { id: 'custom', label: 'Custom', controls: [] },
];

/** The breakpoints the CSS editor targets (min-width). `null` = base (all
 *  sizes). An edit at a breakpoint writes into `@media (min-width: …)`. */
export const CSS_BREAKPOINTS: { label: string; minPx: number | null }[] = [
  { label: 'Base', minPx: null },
  { label: 'SM', minPx: 640 },
  { label: 'MD', minPx: 768 },
  { label: 'LG', minPx: 1024 },
  { label: 'XL', minPx: 1280 },
];

/** Map a CSS property to the category whose controls edit it — powers "add a
 *  property" jumping to the right section. Spacing shorthands/longhands map to
 *  the box-model editor's category. */
export const PROP_TO_CATEGORY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const cat of CSS_CATEGORIES) {
    for (const c of cat.controls) map[c.prop] = cat.id;
  }
  for (const t of ['padding', 'margin']) {
    map[t] = 'spacing';
    for (const s of ['top', 'right', 'bottom', 'left']) map[`${t}-${s}`] = 'spacing';
  }
  return map;
})();
