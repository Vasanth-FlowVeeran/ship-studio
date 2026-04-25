import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkspaceLayout } from './useWorkspaceLayout';

describe('useWorkspaceLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useWorkspaceLayout({ isGitHubConnected: false }));

    expect(result.current.showHealthLogs).toBe(false);
    expect(result.current.isPreviewHidden).toBe(false);
    expect(result.current.workspaceTab).toBe('preview');
  });

  it('switches workspace tabs', () => {
    const { result } = renderHook(() => useWorkspaceLayout({ isGitHubConnected: true }));

    act(() => {
      result.current.setWorkspaceTab('branches');
    });
    expect(result.current.workspaceTab).toBe('branches');

    act(() => {
      result.current.setWorkspaceTab('prs');
    });
    expect(result.current.workspaceTab).toBe('prs');
  });

  it('projects workspaceTab to preview when GitHub disconnects', () => {
    const { result, rerender } = renderHook(
      ({ connected }) => useWorkspaceLayout({ isGitHubConnected: connected }),
      { initialProps: { connected: true } }
    );

    act(() => {
      result.current.setWorkspaceTab('branches');
    });
    expect(result.current.workspaceTab).toBe('branches');

    rerender({ connected: false });

    // Disconnected → the derived view falls back to preview
    expect(result.current.workspaceTab).toBe('preview');

    // Reconnect — the user's original selection comes back (state was preserved)
    rerender({ connected: true });
    expect(result.current.workspaceTab).toBe('branches');
  });

  it('does not reset preview tab when GitHub disconnects if already on preview', () => {
    const { result, rerender } = renderHook(
      ({ connected }) => useWorkspaceLayout({ isGitHubConnected: connected }),
      { initialProps: { connected: true } }
    );

    rerender({ connected: false });

    expect(result.current.workspaceTab).toBe('preview');
  });

  it('resets layout clears log panels', () => {
    const { result } = renderHook(() => useWorkspaceLayout({ isGitHubConnected: false }));

    act(() => {
      result.current.setShowHealthLogs(true);
    });

    act(() => {
      result.current.resetLayout();
    });

    expect(result.current.showHealthLogs).toBe(false);
  });

  it('toggles preview visibility', () => {
    const { result } = renderHook(() => useWorkspaceLayout({ isGitHubConnected: false }));

    act(() => {
      result.current.setIsPreviewHidden(true);
    });
    expect(result.current.isPreviewHidden).toBe(true);
  });
});
