/**
 * Assentor TUI keyboard map + reducer — Workspace-first IA.
 * Primary nav exposes intent (tasks/agents/review), not internal entities.
 */

export const NAV_SCREENS = [
  { id: "workspace", label: "Workspace", hint: "Start / continue work" },
  { id: "tasks", label: "Tasks", hint: "Task history & status" },
  { id: "agents", label: "Agents", hint: "Specialty roles" },
  { id: "review", label: "Review", hint: "Review plan & findings" },
  { id: "configuration", label: "Configure", hint: "AI, keys, defaults" },
  { id: "diagnostics", label: "Diagnostics", hint: "Check & fix" },
  { id: "help", label: "Help", hint: "Shortcuts & commands" },
] as const;

export type ScreenId = (typeof NAV_SCREENS)[number]["id"];

export type FocusPane = "nav" | "main" | "palette" | "dialog";

export type DialogKind =
  | "none"
  | "palette"
  | "help"
  | "start-task"
  | "add-key"
  | "review-plan"
  | "ai-defaults"
  | "confirm-uninstall"
  | "add-reviewer"
  | "confirm-delete-task"
  | "agent-editor";

/** Configuration subsections (progressive disclosure). */
export type ConfigSection =
  | "menu"
  | "ai"
  | "keys"
  | "executors"
  | "review"
  | "advanced"
  | "system";

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
  configSection: ConfigSection;
  /** Selected task id when viewing task detail (null = list). */
  selectedTaskId: string | null;
  capturingText: boolean;
  busy: boolean;
  paletteQuery: string;
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
  | { type: "open_palette" }
  | { type: "open_help" }
  | { type: "start_task" }
  | { type: "review_plan" }
  | { type: "keys_add" }
  | { type: "keys_check" }
  | { type: "keys_check_all" }
  | { type: "keys_delete" }
  | { type: "reviewers_add" }
  | { type: "reviewers_delete" }
  | { type: "task_resume" }
  | { type: "task_delete" }
  | { type: "executors_detect" }
  | { type: "executors_install" }
  | { type: "executors_use" }
  | { type: "cycle_mode" }
  | { type: "save_defaults" }
  | { type: "noop" };

export function createInitialUiState(
  overrides: Partial<UiState> = {},
): UiState {
  return {
    screen: "workspace",
    focus: "main",
    navIndex: 0,
    mainIndex: 0,
    mainItemCount: 4,
    dialog: "none",
    configSection: "menu",
    selectedTaskId: null,
    capturingText: false,
    busy: false,
    paletteQuery: "",
    ...overrides,
  };
}

export function screenAt(index: number): ScreenId {
  const item =
    NAV_SCREENS[Math.max(0, Math.min(index, NAV_SCREENS.length - 1))];
  return item!.id;
}

export function mapKeyToAction(state: UiState, key: KeyEvent): UiAction {
  if (state.busy) return { type: "noop" };

  // Ctrl+K / Ctrl+P → palette
  if (key.ctrl && (key.input === "k" || key.input === "p")) {
    return { type: "open_palette" };
  }

  if (state.dialog === "palette") {
    if (key.escape) return { type: "escape" };
    if (key.upArrow || key.input === "k") return { type: "main_up" };
    if (key.downArrow || key.input === "j") return { type: "main_down" };
    if (key.return) return { type: "activate" };
    return { type: "noop" };
  }

  if (state.capturingText) {
    if (key.escape) return { type: "escape" };
    if (key.return) return { type: "activate" };
    return { type: "noop" };
  }

  if (state.dialog !== "none") {
    if (key.escape) return { type: "escape" };
    if (key.upArrow || key.input === "k") return { type: "main_up" };
    if (key.downArrow || key.input === "j") return { type: "main_down" };
    if (state.dialog === "ai-defaults") {
      if (key.leftArrow) return { type: "cycle_left" };
      if (key.rightArrow) return { type: "cycle_right" };
    }
    if (key.return || key.input === " ") return { type: "activate" };
    return { type: "noop" };
  }

  if (key.escape) return { type: "escape" };
  if (key.input === "?") return { type: "open_help" };
  if (key.input === "/") return { type: "open_palette" };

  if (key.tab) {
    return state.focus === "nav" ? { type: "focus_main" } : { type: "focus_nav" };
  }

  if (state.focus === "nav") {
    if (key.upArrow || key.input === "k") return { type: "nav_up" };
    if (key.downArrow || key.input === "j") return { type: "nav_down" };
    if (key.rightArrow) return { type: "focus_main" };
    if (key.return || key.input === " ") return { type: "select_nav" };
    if (key.input === "q") return { type: "quit" };
    return { type: "noop" };
  }

  // main focus — arrows stay on this screen (Tab/Esc for nav).
  if (key.upArrow || key.input === "k") return { type: "main_up" };
  if (key.downArrow || key.input === "j") return { type: "main_down" };
  if (key.return) return { type: "activate" };
  if (key.input === " ") return { type: "space" };
  if (key.input === "q") return { type: "focus_nav" };

  const editingConfig =
    state.screen === "configuration" &&
    (state.configSection === "ai" ||
      state.configSection === "review" ||
      state.configSection === "advanced");
  if (editingConfig) {
    if (key.leftArrow) return { type: "cycle_left" };
    if (key.rightArrow) return { type: "cycle_right" };
    if (key.input === "s") return { type: "save_defaults" };
  }

  // Contextual shortcuts
  if (state.screen === "workspace") {
    if (key.input === "n") return { type: "start_task" };
    if (key.input === "r") return { type: "review_plan" };
    if (key.input === "m") return { type: "cycle_mode" };
  }
  if (state.screen === "tasks") {
    if (key.input === "n") return { type: "start_task" };
    if (key.input === "r") return { type: "task_resume" };
    if (key.input === "d") return { type: "task_delete" };
  }
  if (state.screen === "review" && key.input === "p") {
    return { type: "review_plan" };
  }
  if (state.screen === "configuration" && state.configSection === "review") {
    if (key.input === "a") return { type: "reviewers_add" };
    if (key.input === "d") return { type: "reviewers_delete" };
  }
  if (state.screen === "configuration" && state.configSection === "keys") {
    if (key.input === "a") return { type: "keys_add" };
    if (key.input === "c") return { type: "keys_check" };
    if (key.input === "C") return { type: "keys_check_all" };
    if (key.input === "d") return { type: "keys_delete" };
  }
  if (
    state.screen === "configuration" &&
    state.configSection === "executors"
  ) {
    if (key.input === "r") return { type: "executors_detect" };
    if (key.input === "i") return { type: "executors_install" };
    if (key.input === "u") return { type: "executors_use" };
  }

  return { type: "noop" };
}

export function reduceUi(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "noop":
      return state;
    case "quit":
      return state;
    case "nav_up":
      return {
        ...state,
        navIndex: Math.max(0, state.navIndex - 1),
      };
    case "nav_down":
      return {
        ...state,
        navIndex: Math.min(NAV_SCREENS.length - 1, state.navIndex + 1),
      };
    case "main_up":
      return {
        ...state,
        mainIndex: Math.max(0, state.mainIndex - 1),
      };
    case "main_down":
      return {
        ...state,
        mainIndex: Math.min(
          Math.max(0, state.mainItemCount - 1),
          state.mainIndex + 1,
        ),
      };
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
        selectedTaskId: null,
        configSection: screen === "configuration" ? "menu" : state.configSection,
        dialog: "none",
      };
    }
    case "escape": {
      if (state.dialog !== "none") {
        return {
          ...state,
          dialog: "none",
          capturingText: false,
          paletteQuery: "",
          focus: "main",
        };
      }
      if (state.selectedTaskId) {
        return { ...state, selectedTaskId: null, mainIndex: 0 };
      }
      if (state.screen === "configuration" && state.configSection !== "menu") {
        return { ...state, configSection: "menu", mainIndex: 0 };
      }
      return { ...state, focus: "nav" };
    }
    case "open_palette":
      return {
        ...state,
        dialog: "palette",
        focus: "palette",
        mainIndex: 0,
        paletteQuery: "",
      };
    case "open_help":
      return { ...state, dialog: "help", focus: "dialog", mainIndex: 0 };
    case "start_task":
      return {
        ...state,
        dialog: "start-task",
        focus: "dialog",
        capturingText: true,
        mainIndex: 0,
      };
    case "review_plan":
      return { ...state, dialog: "review-plan", focus: "dialog", mainIndex: 0 };
    case "keys_add":
      return {
        ...state,
        dialog: "add-key",
        focus: "dialog",
        capturingText: false,
        mainIndex: 0,
      };
    case "reviewers_add":
      return {
        ...state,
        dialog: "add-reviewer",
        focus: "dialog",
        capturingText: false,
        mainIndex: 0,
      };
    case "activate":
    case "space":
    case "cycle_left":
    case "cycle_right":
    case "save_defaults":
    case "keys_check":
    case "keys_check_all":
    case "keys_delete":
    case "reviewers_delete":
    case "task_resume":
    case "task_delete":
    case "executors_detect":
    case "executors_install":
    case "executors_use":
    case "cycle_mode":
      return state;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function footerHints(state: UiState): string {
  if (state.dialog === "palette") {
    return "↑↓ Select · Enter Run · Esc Close · type to filter";
  }
  if (state.dialog === "help") {
    return "Esc Close · / Commands · ? This help";
  }
  if (state.dialog === "start-task") {
    return "Type · Enter Next · Esc Cancel";
  }
  if (state.dialog === "add-key") {
    return "↑↓ Provider · Enter Next · Esc Cancel";
  }
  if (state.dialog === "review-plan") {
    return "Enter Close · Esc Back";
  }
  if (state.dialog === "ai-defaults") {
    return "↑↓ Field · ←→ Cycle · Enter Save · Esc Cancel";
  }
  if (state.dialog === "add-reviewer") {
    return "↑↓ Choose · Enter Next · Esc Cancel";
  }
  if (state.dialog === "confirm-delete-task") {
    return "↑↓ · Enter Confirm · Esc Cancel";
  }
  if (state.dialog === "confirm-uninstall") {
    return "↑↓ · Enter Confirm · Esc Cancel";
  }
  if (state.focus === "nav") {
    return "↑↓ Highlight · Enter Open · Tab Main · / Commands · ? Help · q Quit";
  }

  switch (state.screen) {
    case "workspace":
      return "↑↓ Actions · Enter · n New task · m Mode · Tab Nav · / Commands";
    case "tasks":
      return state.selectedTaskId
        ? "r Resume (failed/timeout) · d Delete · Esc Back"
        : "↑↓ Select · Enter Open · r Resume · d Delete · n New";
    case "agents":
      return "↑↓ Browse specialties · Tab Nav · add backends in Configure → Reviewers";
    case "review":
      return "↑↓ · Enter · p Explain reviewers · Tab Nav";
    case "configuration":
      if (state.configSection === "keys") {
        return "a Add · c Check · C Check all · d Delete · Esc Back";
      }
      if (state.configSection === "executors") {
        return "r Detect · u Use · i Install plan · Enter Check · Esc Back";
      }
      if (state.configSection === "review") {
        return "a Add · d Delete · ←→ How many · s Save · Esc Back";
      }
      if (state.configSection === "menu") {
        return "↑↓ Section · Enter Open · Tab Nav";
      }
      return "↑↓ Field · ←→ Change value · s Save · Esc Back";
    case "diagnostics":
      return "Enter Refresh · Esc Nav · / Commands";
    case "help":
      return "/ Commands · Esc Nav · q Quit from nav";
    default:
      return "↑↓ · Enter · Esc · / · ?";
  }
}

/** Slash / palette commands (action-oriented). */
export interface PaletteCommand {
  id: string;
  label: string;
  keywords: string[];
  /** Screen to navigate to, optional */
  screen?: ScreenId;
  /** Dialog to open */
  dialog?: DialogKind;
  configSection?: ConfigSection;
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
  {
    id: "task-new",
    label: "Start a new task",
    keywords: ["task", "new", "start", "run"],
    dialog: "start-task",
  },
  {
    id: "mode-cycle",
    label: "Cycle run mode (Supervised / Autopilot)",
    keywords: ["mode", "autopilot", "supervised", "phase", "agent"],
  },
  {
    id: "task-list",
    label: "Open tasks",
    keywords: ["task", "list", "history", "resume"],
    screen: "tasks",
  },
  {
    id: "review-plan",
    label: "Explain reviewers for a goal",
    keywords: ["review", "plan", "why", "reviewers"],
    dialog: "review-plan",
  },
  {
    id: "review",
    label: "Open review",
    keywords: ["review"],
    screen: "review",
  },
  {
    id: "agents",
    label: "Browse specialty roles",
    keywords: ["agent", "specialty", "role"],
    screen: "agents",
  },
  {
    id: "config-reviewers",
    label: "Add reviewers",
    keywords: ["reviewer", "gemini", "claude", "cursor", "antigravity", "cli", "panel"],
    screen: "configuration",
    configSection: "review",
  },
  {
    id: "config-ai",
    label: "Configure AI defaults",
    keywords: ["config", "ai", "model", "defaults"],
    screen: "configuration",
    configSection: "ai",
    dialog: "ai-defaults",
  },
  {
    id: "config-keys",
    label: "API keys",
    keywords: ["key", "api", "secret"],
    screen: "configuration",
    configSection: "keys",
  },
  {
    id: "config-executors",
    label: "Executors",
    keywords: ["executor", "cursor", "cli", "install"],
    screen: "configuration",
    configSection: "executors",
  },
  {
    id: "diagnostics",
    label: "Run diagnostics",
    keywords: ["diag", "check", "health", "doctor"],
    screen: "diagnostics",
  },
  {
    id: "workspace",
    label: "Workspace home",
    keywords: ["home", "workspace", "dashboard"],
    screen: "workspace",
  },
  {
    id: "help",
    label: "Help",
    keywords: ["help", "shortcuts"],
    screen: "help",
    dialog: "help",
  },
];

export function filterPaletteCommands(
  query: string,
  commands: PaletteCommand[] = PALETTE_COMMANDS,
): PaletteCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return commands;
  return commands.filter((cmd) => {
    const hay = [cmd.id, cmd.label, ...cmd.keywords].join(" ").toLowerCase();
    return q.split(/\s+/).every((part) => hay.includes(part));
  });
}
