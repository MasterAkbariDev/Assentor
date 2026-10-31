import { useEffect } from "react";
import { isHelpKey, isPaletteKey, isTypingTarget } from "../../keymap.js";

/**
 * Global shortcuts: Ctrl/⌘+K opens the command palette, `?` the keyboard map.
 * Ignored while typing in a field, and while another dialog is open (`enabled`).
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
      if (isTypingTarget(event.target)) return;
      if (isPaletteKey(event)) {
        event.preventDefault();
        onPalette();
      } else if (isHelpKey(event)) {
        event.preventDefault();
        onHelp();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, onPalette, onHelp]);
}
