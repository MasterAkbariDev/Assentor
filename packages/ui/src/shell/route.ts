import { useSyncExternalStore } from "react";

/**
 * Minimal hash router: `#/prompts` → "prompts". TanStack Router is not in the approved
 * dependency set (STATUS §6); swap this file for it when the full UI adds it.
 */

export const SECTIONS = [
  { id: "sessions", label: "Sessions" },
  { id: "prompts", label: "Prompts" },
  { id: "teams", label: "Teams" },
  { id: "playbooks", label: "Playbooks" },
  { id: "settings", label: "Settings" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** `dev/fixtures` exists only in dev builds; `new-session` is reached from the sidebar. Neither is in `SECTIONS`, so neither shows in the nav. */
export type Route = SectionId | "dev/fixtures" | "new-session";

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (import.meta.env.DEV && path === "dev/fixtures") return "dev/fixtures";
  if (path === "new-session") return "new-session";
  return SECTIONS.find((s) => s.id === path)?.id ?? "sessions";
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));
}
