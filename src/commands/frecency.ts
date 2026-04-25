/**
 * localStorage-backed frecency (frequency + recency) tracker.
 *
 * Score formula: `count / (1 + daysSinceLastUsed)`. Standard Mozilla-style
 * frecency — a command used 10 times yesterday ranks above one used 20
 * times last month. Commands that have never been used get 0.
 *
 * We cache the parsed map in module memory and persist on every record so
 * subsequent reads are allocation-free.
 */

const STORAGE_KEY = 'ship-studio-palette-frecency';

interface Entry {
  count: number;
  lastUsed: number; // epoch ms
}

type FrecencyMap = Record<string, Entry>;

let cache: FrecencyMap | null = null;

function load(): FrecencyMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as FrecencyMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  if (!cache) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota errors are non-fatal — frecency just won't survive this session.
  }
}

/** Record a palette command run. Updates cache + localStorage. */
export function recordRun(id: string): void {
  const map = load();
  const prev = map[id];
  map[id] = {
    count: (prev?.count ?? 0) + 1,
    lastUsed: Date.now(),
  };
  persist();
}

/** Score in [0, ~∞). Newer + frequently-used commands get higher values. */
export function frecencyBoost(id: string): number {
  const entry = load()[id];
  if (!entry) return 0;
  const days = (Date.now() - entry.lastUsed) / (1000 * 60 * 60 * 24);
  return entry.count / (1 + days);
}

/** Test helper. */
export function _reset(): void {
  cache = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
