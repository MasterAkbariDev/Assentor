/**
 * Subsequence match for the command palette: every letter of `query` must appear
 * in `text`, in order. Returns null when one is missing, else a score where higher
 * is better. Consecutive letters and word starts score more.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    if (at === prev + 1) score += 3;
    else score += 1;
    if (at === 0 || /[\s\/\-_.:]/.test(t.charAt(at - 1))) score += 2;
    score -= (at - from) * 0.1; // a gap costs a little
    prev = at;
    from = at + 1;
  }
  return score - t.length * 0.01; // on a tie, the shorter label wins
}

/** The items that match `query`, best first. Ties keep the order they came in. */
export function rankItems<T extends { label: string }>(items: readonly T[], query: string): T[] {
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, item.label);
    if (score !== null) scored.push({ item, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}
