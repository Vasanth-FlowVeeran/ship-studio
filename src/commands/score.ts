/**
 * Word-boundary-aware fuzzy scorer for palette results.
 *
 * Returns a score in [0, 1] where higher = better. Zero means "not a match"
 * — filter those out before ranking. Non-zero scores are then weighted by
 * frecency at the call site.
 *
 * Priorities (highest to lowest):
 *   1.00  exact match                      "home" vs "home"
 *   0.95  prefix match                     "hom"  vs "home"
 *   0.85  word-boundary match              "serv" vs "Restart dev server"
 *   0.75  camelCase/initial match          "rds"  vs "Restart Dev Server"
 *   0.60  substring hit
 *   0.50  keyword match (lower weight so the title wins)
 *   0.00  no hit
 */

export function scoreMatch(query: string, title: string, keywords?: string[]): number {
  if (!query) return 0.5; // Neutral when query is empty — ordering defers to frecency.
  const q = query.toLowerCase().trim();
  if (!q) return 0.5;

  const titleScore = scoreAgainst(q, title.toLowerCase());
  if (titleScore > 0) return titleScore;

  if (keywords?.length) {
    for (const kw of keywords) {
      const s = scoreAgainst(q, kw.toLowerCase());
      if (s > 0) return Math.min(s, 0.5); // cap keyword hits
    }
  }
  return 0;
}

function scoreAgainst(q: string, text: string): number {
  if (text === q) return 1;
  if (text.startsWith(q)) return 0.95;

  // Word-boundary (space, dash, dot, underscore, slash).
  const words = text.split(/[\s\-._/]+/);
  if (words.some((w) => w.startsWith(q))) return 0.85;

  // Initials / camelCase: "rds" -> "Restart Dev Server" or "restartDevServer".
  if (q.length >= 2) {
    const initials = extractInitials(text);
    if (initials.startsWith(q)) return 0.75;
  }

  if (text.includes(q)) return 0.6;
  return 0;
}

function extractInitials(text: string): string {
  // Word-start letters + lowercase-to-uppercase transitions (camelCase).
  const parts = text.split(/[\s\-._/]+/);
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    out += part[0];
    for (let i = 1; i < part.length; i++) {
      const prev = part[i - 1];
      const curr = part[i];
      if (prev === prev.toLowerCase() && curr !== curr.toLowerCase()) {
        out += curr.toLowerCase();
      }
    }
  }
  return out;
}
