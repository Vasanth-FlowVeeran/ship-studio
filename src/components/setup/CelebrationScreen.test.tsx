/**
 * Tests for CelebrationScreen component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CelebrationScreen } from './CelebrationScreen';

describe('CelebrationScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "You\'re all set!" text', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} />);

    expect(screen.getByText("You're all set!")).toBeInTheDocument();
    expect(screen.getByText('Everything is installed and connected')).toBeInTheDocument();
  });

  it('calls onContinue after 2500ms auto-timer', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} />);

    expect(onContinue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2500);

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('click "Get Started" calls onContinue immediately', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} />);

    fireEvent.click(screen.getByText('Get Started'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('animates in (visible class applied after 100ms)', () => {
    const onContinue = vi.fn();
    const { container } = render(<CelebrationScreen onContinue={onContinue} />);

    const screenEl = container.querySelector('.celebration-screen');
    expect(screenEl).not.toHaveClass('visible');

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screenEl).toHaveClass('visible');
  });
});
