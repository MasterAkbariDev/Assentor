import { useEffect } from "react";
import { isComposing, isHelpKey, isPaletteKey, isTextEntry, isTypingTarget } from "../../keymap.js";

/**
 * Global shortcuts: Ctrl/⌘+K opens the command palette (not from text fields; a
 * focused select is fine), `?` opens the keyboard map (not while typing or in a
 * select). Ignored during IME composition, for events another handler already
 * used, and while another dialog is open (`enabled`).
 */
export function useShortcuts({
  enabled,
  onPalette,
  onHelp,
}: {
  enabled: boolean;
  onPalette: () => void;
  onHelp: () => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event)) return;
      if (isPaletteKey(event)) {
        if (isTextEntry(event.target)) return;
        event.preventDefault();
        onPalette();
      } else if (isHelpKey(event)) {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        onHelp();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, onPalette, onHelp]);
}
