import { describe, expect, it } from "vitest";
import {
  createInitialUiState,
  footerHints,
  mapKeyToAction,
  NAV_SCREENS,
  reduceUi,
  screenAt,
  type KeyEvent,
  type UiAction,
  type UiState,
} from "../../src/tui/keymap.js";

function key(partial: Partial<KeyEvent> & { input?: string }): KeyEvent {
  return { input: "", ...partial };
}

function apply(state: UiState, event: KeyEvent): { state: UiState; action: UiAction } {
  const action = mapKeyToAction(state, event);
  return { state: reduceUi(state, action), action };
}

describe("TUI keyboard map (spec §44)", () => {
  it("documents navigation keys across panes: ↑↓←→ Enter Esc q Tab Space", () => {
    const documented = [
      "upArrow → nav_up | main_up",
      "downArrow → nav_down | main_down",
      "leftArrow → focus_nav | cycle_left (defaults)",
      "rightArrow → focus_main | cycle_right (defaults)",
      "return → select_nav | activate",
      "escape → escape",
      "tab → toggle focus",
      "q → quit (nav, no dialog)",
      "space → space",
    ];
    expect(documented.length).toBe(9);
    expect(NAV_SCREENS.map((s) => s.id)).toEqual([
      "dashboard",
      "tasks",
      "agents",
      "executors",
      "providers",
      "models",
      "keys",
      "review",
      "diagnostics",
      "logs",
      "settings",
      "system",
    ]);
  });

  it("↑↓ moves nav selection and wraps", () => {
    let state = createInitialUiState({ focus: "nav", navIndex: 0 });
    ({ state } = apply(state, key({ upArrow: true })));
    expect(state.navIndex).toBe(NAV_SCREENS.length - 1);
    ({ state } = apply(state, key({ downArrow: true })));
    expect(state.navIndex).toBe(0);
    ({ state } = apply(state, key({ downArrow: true })));
    expect(state.navIndex).toBe(1);
  });

  it("→ and Tab move focus to main; ← and Tab return to nav", () => {
    let state = createInitialUiState({ focus: "nav" });
    let action: UiAction;
    ({ state, action } = apply(state, key({ rightArrow: true })));
    expect(action.type).toBe("focus_main");
    expect(state.focus).toBe("main");

    ({ state, action } = apply(state, key({ tab: true })));
    expect(action.type).toBe("focus_nav");
    expect(state.focus).toBe("nav");

    ({ state, action } = apply(state, key({ tab: true })));
    expect(state.focus).toBe("main");

    ({ state, action } = apply(state, key({ leftArrow: true })));
    expect(action.type).toBe("focus_nav");
    expect(state.focus).toBe("nav");
  });

  it("Enter on nav selects screen and focuses main", () => {
    let state = createInitialUiState({
      focus: "nav",
      navIndex: NAV_SCREENS.findIndex((s) => s.id === "keys"),
    });
    ({ state } = apply(state, key({ return: true })));
    expect(state.screen).toBe("keys");
    expect(state.focus).toBe("main");
    expect(state.mainIndex).toBe(0);
    expect(screenAt(state.navIndex)).toBe("keys");
  });

  it("↑↓ on main pane cycles mainIndex with wrap", () => {
    let state = createInitialUiState({
      focus: "main",
      mainItemCount: 3,
      mainIndex: 0,
    });
    ({ state } = apply(state, key({ upArrow: true })));
    expect(state.mainIndex).toBe(2);
    ({ state } = apply(state, key({ downArrow: true })));
    expect(state.mainIndex).toBe(0);
  });

  it("Esc closes dialogs then returns focus to nav", () => {
    let state = createInitialUiState({
      focus: "main",
      dialog: "review-plan",
    });
    ({ state } = apply(state, key({ escape: true })));
    expect(state.dialog).toBe("none");
    expect(state.focus).toBe("main");

    ({ state } = apply(state, key({ escape: true })));
    expect(state.focus).toBe("nav");
  });

  it("q quits only from nav without dialog", () => {
    const nav = createInitialUiState({ focus: "nav" });
    expect(mapKeyToAction(nav, key({ input: "q" })).type).toBe("quit");

    const main = createInitialUiState({ focus: "main" });
    expect(mapKeyToAction(main, key({ input: "q" })).type).toBe("noop");

    const dialog = createInitialUiState({ focus: "nav", dialog: "defaults" });
    expect(mapKeyToAction(dialog, key({ input: "q" })).type).toBe("noop");
  });

  it("Space emits space action for activate mirroring", () => {
    const state = createInitialUiState({ focus: "main", screen: "tasks" });
    expect(mapKeyToAction(state, key({ input: " " })).type).toBe("space");
  });

  it("← → cycle defaults when defaults dialog is open", () => {
    const state = createInitialUiState({
      focus: "main",
      dialog: "defaults",
    });
    expect(mapKeyToAction(state, key({ leftArrow: true })).type).toBe(
      "cycle_left",
    );
    expect(mapKeyToAction(state, key({ rightArrow: true })).type).toBe(
      "cycle_right",
    );
  });

  it("keys screen shortcuts: a / c / C / d", () => {
    const state = createInitialUiState({ focus: "main", screen: "keys" });
    expect(mapKeyToAction(state, key({ input: "a" })).type).toBe("keys_add");
    expect(mapKeyToAction(state, key({ input: "c" })).type).toBe("keys_check");
    expect(mapKeyToAction(state, key({ input: "C" })).type).toBe(
      "keys_check_all",
    );
    expect(mapKeyToAction(state, key({ input: "d" })).type).toBe("keys_delete");
  });

  it("executors / review shortcuts", () => {
    const exec = createInitialUiState({ focus: "main", screen: "executors" });
    expect(mapKeyToAction(exec, key({ input: "i" })).type).toBe(
      "executors_install",
    );
    expect(mapKeyToAction(exec, key({ input: "r" })).type).toBe(
      "executors_detect",
    );

    const review = createInitialUiState({ focus: "main", screen: "review" });
    expect(mapKeyToAction(review, key({ input: "p" })).type).toBe("review_plan");
    const reduced = reduceUi(review, { type: "review_plan" });
    expect(reduced.dialog).toBe("review-plan");
  });

  it("busy and text-capture ignore most keys", () => {
    const busy = createInitialUiState({ busy: true });
    expect(mapKeyToAction(busy, key({ downArrow: true })).type).toBe("noop");

    const capture = createInitialUiState({ capturingText: true });
    expect(mapKeyToAction(capture, key({ input: "x" })).type).toBe("noop");
    expect(mapKeyToAction(capture, key({ escape: true })).type).toBe("escape");
    expect(mapKeyToAction(capture, key({ return: true })).type).toBe("activate");
  });

  it("footerHints reflect focus and screen shortcuts", () => {
    expect(footerHints(createInitialUiState({ focus: "nav" }))).toMatch(/quit/);
    expect(
      footerHints(createInitialUiState({ focus: "main", screen: "keys" })),
    ).toMatch(/Check All/);
    expect(
      footerHints(
        createInitialUiState({ focus: "main", dialog: "review-plan" }),
      ),
    ).toMatch(/Review Plan/);
  });
});
