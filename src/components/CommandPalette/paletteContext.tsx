import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useOpenModal } from '../../contexts/ModalContext';
import type { CommandCategory } from '../../commands/types';

/**
 * Which area of the app the palette should adapt to.
 *
 * - `home` — dashboard / projects list (no current project)
 * - `project` — workspace or project-loading (a project is active)
 * - `other` — loading / onboarding / transitional states
 */
export type PaletteContextKind = 'home' | 'project' | 'other';

/** Tab ids accepted by the palette (matches `PaletteTabId` inside the palette). */
export type PaletteTabId = 'all' | CommandCategory;

interface PaletteContextValue {
  kind: PaletteContextKind;
  currentProjectName: string | null;
  currentProjectPath: string | null;
}

interface PaletteContextAPI {
  value: PaletteContextValue;
  set: (next: PaletteContextValue) => void;
  /** Request a tab for the next palette open (replaces any prior request). */
  setPendingTab: (tab: PaletteTabId | null) => void;
  /** Read + clear the pending-tab request. Returns null if none set. */
  consumePendingTab: () => PaletteTabId | null;
}

const Ctx = createContext<PaletteContextAPI | null>(null);

export function PaletteContextProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<PaletteContextValue>({
    kind: 'other',
    currentProjectName: null,
    currentProjectPath: null,
  });
  const pendingTabRef = useRef<PaletteTabId | null>(null);

  const set = useCallback((next: PaletteContextValue) => {
    setValue((prev) =>
      prev.kind === next.kind &&
      prev.currentProjectName === next.currentProjectName &&
      prev.currentProjectPath === next.currentProjectPath
        ? prev
        : next
    );
  }, []);

  const setPendingTab = useCallback((tab: PaletteTabId | null) => {
    pendingTabRef.current = tab;
  }, []);

  const consumePendingTab = useCallback((): PaletteTabId | null => {
    const tab = pendingTabRef.current;
    pendingTabRef.current = null;
    return tab;
  }, []);

  const api = useMemo<PaletteContextAPI>(
    () => ({ value, set, setPendingTab, consumePendingTab }),
    [value, set, setPendingTab, consumePendingTab]
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePaletteContext(): PaletteContextValue {
  const api = useContext(Ctx);
  if (!api) throw new Error('usePaletteContext must be used inside PaletteContextProvider');
  return api.value;
}

export function useSetPaletteContext() {
  const api = useContext(Ctx);
  if (!api) throw new Error('useSetPaletteContext must be used inside PaletteContextProvider');
  return api.set;
}

/**
 * Read + clear the "open palette on tab X" request. Returns the requested
 * tab (if any) and wipes the request so it only applies to this open.
 */
export function useConsumePendingTab(): () => PaletteTabId | null {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConsumePendingTab must be used inside PaletteContextProvider');
  return api.consumePendingTab;
}

/**
 * Single-call hook to open the palette — optionally pre-selecting a tab.
 *
 * ```tsx
 * const openPalette = useOpenPalette();
 * openPalette();                  // default: All
 * openPalette({ tab: 'project' }); // land on Projects tab
 * ```
 */
export function useOpenPalette(): (opts?: { tab?: PaletteTabId }) => void {
  const api = useContext(Ctx);
  if (!api) throw new Error('useOpenPalette must be used inside PaletteContextProvider');
  const openModal = useOpenModal();
  const { setPendingTab } = api;
  return useCallback(
    (opts) => {
      setPendingTab(opts?.tab ?? null);
      openModal('commandPalette');
    },
    [setPendingTab, openModal]
  );
}
