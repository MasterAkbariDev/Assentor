const KEY = "assentor.recentSessions";

/** Recent run ids from localStorage, newest first, at most `limit`. Empty when storage is missing, blocked or corrupt. */
export function loadRecents(limit: number): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, limit) : [];
  } catch {
    return [];
  }
}

export function saveRecents(ids: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // not persisted; the in-memory list still works
  }
}
