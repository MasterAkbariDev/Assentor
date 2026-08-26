import { describe, expect, it } from "vitest";
import {
  createInitialUiState,
  filterPaletteCommands,
  footerHints,
  mapKeyToAction,
  NAV_SCREENS,
  reduceUi,
  screenAt,
} from "../../src/tui/keymap.js";

describe("TUI keyboard map (§44 + UX rewrite)", () => {
  it("defaults to workspace with main focus", () => {
    const state = createInitialUiState();
    expect(state.screen).toBe("workspace");
    expect(state.focus).toBe("main");
    expect(NAV_SCREENS.map((s) => s.id)).toEqual([
      "workspace",
      "tasks",
      "agents",
      "review",
      "configuration",
      "diagnostics",
      "help",
    ]);
  });

  it("navigates nav with j/k and arrows", () => {
    let state = createInitialUiState({ focus: "nav", navIndex: 0 });
    state = reduceUi(state, { type: "nav_down" });
    expect(state.navIndex).toBe(1);
    state = reduceUi(state, { type: "select_nav" });
    expect(state.screen).toBe(screenAt(1));
    expect(state.focus).toBe("main");
  });

  it("opens command palette with / and Ctrl+K", () => {
    const state = createInitialUiState();
    expect(mapKeyToAction(state, { input: "/" }).type).toBe("open_palette");
    expect(mapKeyToAction(state, { input: "k", ctrl: true }).type).toBe(
      "open_palette",
    );
  });

  it("opens help with ?", () => {
    const state = createInitialUiState();
    expect(mapKeyToAction(state, { input: "?" }).type).toBe("open_help");
  });

  it("fuzzy-filters palette commands", () => {
    const hits = filterPaletteCommands("rev");
    expect(hits.some((c) => c.id.includes("review"))).toBe(true);
    expect(filterPaletteCommands("zzzz-none")).toEqual([]);
  });

  it("esc closes dialogs then returns to nav", () => {
    let state = createInitialUiState({ dialog: "help", focus: "dialog" });
    state = reduceUi(state, { type: "escape" });
    expect(state.dialog).toBe("none");
    state = reduceUi(state, { type: "escape" });
    expect(state.focus).toBe("nav");
  });

  it("workspace shortcuts n and r", () => {
    const state = createInitialUiState({ screen: "workspace", focus: "main" });
    expect(mapKeyToAction(state, { input: "n" }).type).toBe("start_task");
    expect(mapKeyToAction(state, { input: "r" }).type).toBe("review_plan");
  });

  it("tab toggles nav/main", () => {
    const nav = createInitialUiState({ focus: "nav" });
    expect(mapKeyToAction(nav, { input: "", tab: true }).type).toBe(
      "focus_main",
    );
    const main = createInitialUiState({ focus: "main" });
    expect(mapKeyToAction(main, { input: "", tab: true }).type).toBe(
      "focus_nav",
    );
  });

  it("footer adapts to screen", () => {
    const ws = createInitialUiState({ screen: "workspace", focus: "main" });
    expect(footerHints(ws)).toMatch(/New task/i);
    const keys = createInitialUiState({
      screen: "configuration",
      configSection: "keys",
      focus: "main",
    });
    expect(footerHints(keys)).toMatch(/Add/);
  });

  it("q on nav quits; q on main returns to nav", () => {
    const nav = createInitialUiState({ focus: "nav" });
    expect(mapKeyToAction(nav, { input: "q" }).type).toBe("quit");
    const main = createInitialUiState({ focus: "main" });
    expect(mapKeyToAction(main, { input: "q" }).type).toBe("focus_nav");
  });

  it("space activates on main", () => {
    const state = createInitialUiState({ focus: "main" });
    expect(mapKeyToAction(state, { input: " " }).type).toBe("space");
  });

  it("enter selects nav item", () => {
    const state = createInitialUiState({ focus: "nav", navIndex: 2 });
    expect(mapKeyToAction(state, { input: "", return: true }).type).toBe(
      "select_nav",
    );
  });

  it("left arrow from main focuses nav", () => {
    const state = createInitialUiState({ focus: "main" });
    expect(mapKeyToAction(state, { input: "", leftArrow: true }).type).toBe(
      "focus_nav",
    );
  });
});
