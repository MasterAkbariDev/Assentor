/**
 * Pure keyboard map + reducer for the Assentor TUI (spec §44).
 * Unit-tested without Ink render.
 */

export const NAV_SCREENS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "executors", label: "Executors" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "keys", label: "API Keys" },
  { id: "review", label: "Review" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
  { id: "system", label: "System" },
] as const;

export type ScreenId = (typeof NAV_SCREENS)[number]["id"];

export type FocusPane = "nav" | "main";

export type DialogKind =
  | "none"
  | "add-key"
  | "review-plan"
  | "confirm-uninstall"
  | "defaults";

export interface KeyEvent {
  input: string;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export interface UiState {
  screen: ScreenId;
  focus: FocusPane;
  navIndex: number;
  mainIndex: number;
  mainItemCount: number;
  dialog: DialogKind;
  /** When true, text capture consumes keys (add-key name/secret). */
  capturingText: boolean;
  busy: boolean;
}

export type UiAction =
  | { type: "nav_up" }
  | { type: "nav_down" }
  | { type: "main_up" }
  | { type: "main_down" }
  | { type: "focus_nav" }
  | { type: "focus_main" }
  | { type: "select_nav" }
  | { type: "activate" }
  | { type: "escape" }
  | { type: "quit" }
  | { type: "space" }
  | { type: "cycle_left" }
  | { type: "cycle_right" }
  | { type: "keys_add" }
  | { type: "keys_check" }
  | { type: "keys_check_all" }
  | { type: "keys_delete" }
  | { type: "executors_detect" }
  | { type: "executors_install" }
  | { type: "review_plan" }
  | { type: "noop" };

export function createInitialUiState(
  overrides: Partial<UiState> = {},
): UiState {
  return {
    screen: "dashboard",
    focus: "nav",
    navIndex: 0,
    mainIndex: 0,
    mainItemCount: 1,
    dialog: "none",
    capturingText: false,
    busy: false,
    ...overrides,
  };
}

export function screenAt(index: number): ScreenId {
  const item = NAV_SCREENS[Math.max(0, Math.min(index, NAV_SCREENS.length - 1))];
  return item!.id;
}

/**
 * Map a raw key event to a high-level UI action.
 * Documents the cross-screen keyboard contract (↑↓←→ Enter Esc q Tab Space).
 */
export function mapKeyToAction(state: UiState, key: KeyEvent): UiAction {
  if (state.busy) {
    return { type: "noop" };
  }

  if (state.capturingText) {
    if (key.escape) return { type: "escape" };
    if (key.return) return { type: "activate" };
    return { type: "noop" };
  }

  if (key.escape) {
    return { type: "escape" };
  }

  if (key.tab) {
    return state.focus === "nav"
      ? { type: "focus_main" }
      : { type: "focus_nav" };
  }

  if (key.input === "q" && state.dialog === "none" && state.focus === "nav") {
    return { type: "quit" };
  }

  if (key.upArrow) {
    return state.focus === "nav" ? { type: "nav_up" } : { type: "main_up" };
  }
  if (key.downArrow) {
    return state.focus === "nav" ? { type: "nav_down" } : { type: "main_down" };
  }

  if (key.leftArrow) {
    if (state.focus === "main" && state.dialog === "defaults") {
      return { type: "cycle_left" };
    }
    if (state.focus === "main") {
      return { type: "focus_nav" };
    }
    return { type: "noop" };
  }

  if (key.rightArrow) {
    if (state.focus === "main" && state.dialog === "defaults") {
      return { type: "cycle_right" };
    }
    if (state.focus === "nav") {
      return { type: "focus_main" };
    }
    return { type: "noop" };
  }

  if (key.return) {
    if (state.focus === "nav") {
      return { type: "select_nav" };
    }
    return { type: "activate" };
  }

  if (key.input === " ") {
    return { type: "space" };
  }

  // Screen-specific shortcuts (main pane or dialog)
  if (state.screen === "keys" && state.dialog === "none") {
    if (key.input === "a") return { type: "keys_add" };
    if (key.input === "c") return { type: "keys_check" };
    if (key.input === "C") return { type: "keys_check_all" };
    if (key.input === "d") return { type: "keys_delete" };
  }

  if (state.screen === "executors" && state.dialog === "none") {
    if (key.input === "i") return { type: "executors_install" };
    if (key.input === "r") return { type: "executors_detect" };
  }

  if (state.screen === "review" && state.dialog === "none") {
    if (key.input === "p") return { type: "review_plan" };
  }

  return { type: "noop" };
}

export function reduceUi(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "noop":
      return state;
    case "nav_up":
      return {
        ...state,
        navIndex:
          (state.navIndex - 1 + NAV_SCREENS.length) % NAV_SCREENS.length,
      };
    case "nav_down":
      return {
        ...state,
        navIndex: (state.navIndex + 1) % NAV_SCREENS.length,
      };
    case "main_up": {
      const count = Math.max(state.mainItemCount, 1);
      return {
        ...state,
        mainIndex: (state.mainIndex - 1 + count) % count,
      };
    }
    case "main_down": {
      const count = Math.max(state.mainItemCount, 1);
      return {
        ...state,
        mainIndex: (state.mainIndex + 1) % count,
      };
    }
    case "focus_nav":
      return { ...state, focus: "nav" };
    case "focus_main":
      return { ...state, focus: "main" };
    case "select_nav": {
      const screen = screenAt(state.navIndex);
      return {
        ...state,
        screen,
        focus: "main",
        mainIndex: 0,
        dialog: "none",
      };
    }
    case "escape": {
      if (state.dialog !== "none") {
        return {
          ...state,
          dialog: "none",
          capturingText: false,
          focus: "main",
        };
      }
      return { ...state, focus: "nav" };
    }
    case "keys_add":
      return {
        ...state,
        dialog: "add-key",
        focus: "main",
        mainIndex: 0,
      };
    case "review_plan":
      return { ...state, dialog: "review-plan", focus: "main" };
    default:
      // activate / space / quit / cycle / key ops handled by App side-effects
      return state;
  }
}

/** Human-readable footer hints for the current context. */
export function footerHints(state: UiState): string {
  if (state.capturingText) {
    return "Type / paste · Enter · Esc cancel";
  }
  if (state.dialog === "review-plan") {
    return "Esc close Review Plan";
  }
  if (state.dialog === "confirm-uninstall") {
    return "↑↓ · Enter confirm · Esc cancel";
  }
  if (state.dialog === "defaults") {
    return "← → cycle · Enter save/cycle · Esc close";
  }
  if (state.dialog === "add-key") {
    return "↑↓ · Enter next · Esc cancel";
  }
  if (state.focus === "nav") {
    return "↑↓ screen · →/Tab main · Enter open · q quit";
  }
  switch (state.screen) {
    case "keys":
      return "[a] Add · [c] Check · [C] Check All · [d] Delete · ←/Tab nav · Esc";
    case "executors":
      return "[r] Detect · [i] Install plan · Enter detect · ←/Tab nav · Esc";
    case "review":
      return "[p] Review Plan · Enter · ←/Tab nav · Esc";
    case "settings":
      return "Enter open · ←/Tab nav · Esc";
    case "system":
      return "Enter · ←/Tab nav · Esc · q from nav to quit";
    default:
      return "↑↓ · Enter · ←/Tab nav · Esc · Space";
  }
}
