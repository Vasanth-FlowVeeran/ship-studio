/**
 * A real code editor (CodeMirror 6) used by the element HTML editor and the
 * CSS-mode Code view: syntax highlighting + a rock-solid caret + saving.
 *
 * History: this started as a transparent textarea overlaid on Shiki-highlighted
 * markup, which kept drifting the colored layer from the caret so clicks landed
 * in the wrong place. We fell back to a plain textarea (reliable, no color), and
 * now use CodeMirror — one editor surface, so the caret can't desync, with
 * proper highlighting back. github-dark-flavoured tokens to match the Code tab.
 *
 * Controlled: `value`/`onChange`. No line wrapping — long lines scroll
 * horizontally, the box scrolls vertically. `lang` picks the grammar.
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
  bracketMatching,
} from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { tags as t } from '@lezer/highlight';
import type { HighlightLang } from '../../lib/highlight';

interface Props {
  value: string;
  onChange: (value: string) => void;
  lang: HighlightLang;
  className?: string;
  placeholder?: string;
}

/* github-dark token colors (same palette the Code tab's Shiki theme uses). */
const ghDark = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#ff7b72' },
  { tag: [t.propertyName], color: '#79c0ff' },
  { tag: [t.variableName], color: '#ffa657' },
  { tag: [t.function(t.variableName), t.labelName], color: '#d2a8ff' },
  {
    tag: [t.number, t.bool, t.atom, t.color, t.constant(t.name), t.standard(t.name)],
    color: '#79c0ff',
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation, t.self],
    color: '#79c0ff',
  },
  { tag: [t.string, t.special(t.string)], color: '#a5d6ff' },
  { tag: [t.comment, t.meta], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.tagName], color: '#7ee787' },
  { tag: [t.attributeName], color: '#79c0ff' },
  { tag: [t.invalid], color: '#f85149' },
]);

/* Editor chrome, themed with our tokens so it matches the panel surface. */
const ssTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text-primary)',
      backgroundColor: 'var(--bg-tertiary)',
      fontSize: 'var(--font-size-xs)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono, monospace)',
      lineHeight: '1.6',
      overflow: 'auto',
      // Custom, theme-matched scrollbars (never the device's white default).
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--border) transparent',
    },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'var(--border)',
      borderRadius: '999px',
      border: '2px solid var(--bg-tertiary)',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: 'var(--text-muted)' },
    '.cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
    // Native caret (no drawSelection layer to make it transparent), tinted bright.
    '.cm-content': { padding: 'var(--spacing-sm) 0', caretColor: 'var(--text-primary)' },
    '.cm-line': { padding: '0 var(--spacing-sm)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--tint)' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--tint-strong)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
  },
  { dark: true }
);

export function CodeOverlayEditor({ value, onChange, lang, className, placeholder }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the listener pointed at the latest onChange without recreating the view.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount the editor. Recreated only when the grammar changes (stable per usage).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        lang === 'css' ? css() : html(),
        syntaxHighlighting(ghDark),
        ssTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value`/`placeholder` are seeded once; external updates flow through the
    // sync effect below. Only the grammar warrants a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // External value changes (e.g. Revert resets the text) → replace the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={`ss-codeedit${className ? ` ${className}` : ''}`} />;
}
