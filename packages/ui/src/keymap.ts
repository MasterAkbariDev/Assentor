/**
 * Keyboard map and platform labels for the web UI (T04-14p). The only platform
 * split is ⌘ on macOS and Ctrl elsewhere; every label goes through `shortcutLabel`.
 */

export type Platform = "mac" | "other";

/** macOS when the browser says so (`navigator.platform`, else the user agent). */
export function detectPlatform(nav: Pick<Navigator, "platform" | "userAgent"> | undefined = globalThis.navigator): Platform {
  if (!nav) return "other";
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent) ? "mac" : "other";
}

/** A key with its platform modifier, e.g. `shortcutLabel("mac", "K")` is "⌘K". */
export function shortcutLabel(platform: Platform, key: string): string {
  return platform === "mac" ? `⌘${key}` : `Ctrl+${key}`;
}

/** The keyboard event fields the matchers read. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+K or ⌘K (either modifier, so the shortcut works on every platform). `code` covers non-Latin layouts. */
export function isPaletteKey(event: KeyLike): boolean {
  const isK = event.key.toLowerCase() === "k" || event.code === "KeyK";
  return isK && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/** `?` typed on its own (Shift is part of typing it on most layouts). */
export function isHelpKey(event: KeyLike): boolean {
  return event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** Keys that finish an input-method composition (Japanese, Chinese, Korean) must not act as shortcuts. */
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** Text entry: fields and text areas where the user types. Ctrl/⌘+K is still ignored here. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea");
}

/** Typing targets for `?`: text entry, and selects (where a letter is a type-ahead search). */
export function isTypingTarget(target: EventTarget | null): boolean {
  return isTextEntry(target) || (target instanceof HTMLElement && target.matches("select"));
}

export interface KeymapEntry {
  keys: string;
  action: string;
}

/** Rows for the `?` help dialog. Only shortcuts the UI really has. */
export function keymapEntries(platform: Platform): KeymapEntry[] {
  return [
    { keys: shortcutLabel(platform, "K"), action: "Open the command palette" },
    { keys: "?", action: "Show this keyboard map" },
    { keys: "↑ ↓", action: "Move through palette entries" },
    { keys: "Enter", action: "Run the highlighted palette entry" },
    { keys: "Esc", action: "Close the palette, this map or a seat drawer" },
    { keys: "Enter / Space", action: "Open a seat card" },
  ];
}
