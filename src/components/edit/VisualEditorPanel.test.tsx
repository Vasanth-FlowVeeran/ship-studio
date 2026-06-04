import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VisualEditorPanel } from './VisualEditorPanel';
import { BASE_BREAKPOINT, DEFAULT_BREAKPOINTS, type Breakpoint } from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

const BREAKPOINTS: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const MD = BREAKPOINTS.find((b) => b.name === 'md')!;

const resolvedSelection: Selection = {
  signature: { className: 'p-3', tagName: 'div', ancestorClasses: [] },
  resolution: {
    status: 'resolved',
    file: 'components/Hero.tsx',
    line: 11,
    column: 1,
    class_name: 'p-3',
    confidence: 'unique',
  },
  instanceCount: 1,
};

function renderPanel(
  selection: Selection | null,
  currentClass = 'p-3',
  activeBreakpoint: Breakpoint = BASE_BREAKPOINT,
  onSelectBreakpoint = vi.fn(),
  breakpointTooWide = false
) {
  return render(
    <VisualEditorPanel
      selection={selection}
      currentClass={currentClass}
      breakpoints={BREAKPOINTS}
      activeBreakpoint={activeBreakpoint}
      breakpointTooWide={breakpointTooWide}
      onSelectBreakpoint={onSelectBreakpoint}
      onStepGap={vi.fn()}
      onSetSide={vi.fn()}
      onApplyEnum={vi.fn()}
      onCommit={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe('VisualEditorPanel', () => {
  it('renders every control for a resolved element', () => {
    renderPanel(resolvedSelection);
    // Source line
    expect(screen.getByText('components/Hero.tsx:11')).toBeInTheDocument();
    // Box-model spacing editor with per-side fields
    expect(screen.getByTestId('spacing-box')).toBeInTheDocument();
    expect(screen.getByLabelText('Padding top')).toBeInTheDocument();
    expect(screen.getByLabelText('Margin left')).toBeInTheDocument();
    // Gap stepper + enum controls
    expect(screen.getByText('Gap')).toBeInTheDocument();
    expect(screen.getByText('Align')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    // Align renders icon buttons ("Left" is unique to Align)
    expect(screen.getByRole('button', { name: 'Left' })).toBeInTheDocument();
    // New properties
    expect(screen.getByText('Opacity')).toBeInTheDocument();
    // Color controls render as swatch buttons that open the picker popover
    expect(screen.getByRole('button', { name: 'Text color' })).toBeInTheDocument();
    // Save button
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows read-only reason and no controls for a read-only element', () => {
    renderPanel({
      signature: { className: 'x', tagName: 'div', ancestorClasses: [] },
      resolution: { status: 'read_only', reason: 'Dynamic classes.' },
      instanceCount: 1,
    });
    expect(screen.getByText('Dynamic classes.')).toBeInTheDocument();
    expect(screen.queryByTestId('spacing-box')).not.toBeInTheDocument();
  });

  it('warns when multiple elements share the source', () => {
    renderPanel({ ...resolvedSelection, instanceCount: 4 });
    expect(screen.getByText(/Editing 4 elements/)).toBeInTheDocument();
  });

  it('renders the breakpoint dropdown showing the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', MD);
    const trigger = screen.getByRole('button', { name: 'Breakpoint' });
    expect(trigger).toHaveTextContent('md · ≥768px');
  });

  it('explains the mobile-first cascade contextually for the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT);
    expect(screen.getByText(/apply to every screen size/i)).toBeInTheDocument();
    renderPanel(resolvedSelection, 'p-3', MD);
    expect(screen.getByText(/from 768px wide and up/i)).toBeInTheDocument();
  });

  it('selecting a breakpoint from the dropdown asks to resize the canvas to that layer', () => {
    const onSelect = vi.fn();
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT, onSelect);
    fireEvent.click(screen.getByRole('button', { name: 'Breakpoint' })); // open
    fireEvent.click(screen.getByRole('option', { name: 'lg · ≥1024px' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'lg', minPx: 1024 }));
  });

  it('shows the "preview too narrow" note when the breakpoint exceeds the canvas', () => {
    renderPanel(
      resolvedSelection,
      'p-3',
      BREAKPOINTS.find((b) => b.name === 'xl'),
      vi.fn(),
      true
    );
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/too narrow to show/i);
    expect(note).toHaveTextContent('xl');
  });

  it('shows a value as inherited when only a smaller breakpoint defines it', () => {
    // gap-4 is set at base; viewing md, the panel reads 4 (inherited from Base).
    renderPanel(resolvedSelection, 'p-3 gap-4', MD);
    expect(screen.getByLabelText<HTMLInputElement>('Gap').value).toBe('4');
    // The Gap label carries an "inherited" indicator pointing at Base.
    expect(screen.getByLabelText('Inherited from Base')).toBeInTheDocument();
  });

  it('reads the active breakpoint value over the base one', () => {
    // base gap-2, md:gap-8 → at md the panel shows 8 (set here, not inherited).
    renderPanel(resolvedSelection, 'gap-2 md:gap-8', MD);
    expect(screen.getByLabelText<HTMLInputElement>('Gap').value).toBe('8');
    expect(screen.getByLabelText('Set on md')).toBeInTheDocument();
  });
});
