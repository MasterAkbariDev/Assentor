// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { SessionSummary } from "#assentor/protocol/rpc.js";
import { App } from "../../App.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { MAX_RESULTS } from "./CommandPalette.js";
const PAUSE_REASON = "the engine has no pause yet";

afterEach(() => {
  cleanup();
  delete (window.navigator as unknown as { platform?: string }).platform;
});

const SESSIONS: SessionSummary[] = [
  { id: sessionFixture.id, title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 16 },
  { id: "old", title: "Old run", status: "DONE", hasLiveLog: false, lastSeq: 0 },
];

/** The app with two runs listed; the fixture run (which has seats) is not selected yet. */
function renderApp(sessions: SessionSummary[] = SESSIONS) {
  const rendered = renderWithStore(<App />);
  act(() => {
    rendered.store.getState().setConnection("connected", "0.4.0");
    rendered.store.getState().setSessions(sessions);
  });
  return rendered;
}

/** Fire a key on `el` (the element that has focus). Returns false when a handler prevented the default. */
function press(el: Element | Document, init: KeyboardEventInit): boolean {
  return fireEvent.keyDown(el, { ...init });
}

function openPalette(opener: HTMLElement) {
  opener.focus();
  press(opener, { key: "k", ctrlKey: true });
}

function field(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

function optionLabels(listbox: HTMLElement): string[] {
  return within(listbox)
    .getAllByRole("option")
    .map((o) => o.querySelector(".palette-label")?.textContent ?? "");
}

describe("command palette: open, close, focus", () => {
  it("opens on Ctrl+K with the search field focused, and Escape restores focus to the opener", () => {
    const { getByRole, queryByRole, getByText } = renderApp();
    const opener = getByText("Old run").closest("button") as HTMLElement;

    openPalette(opener);
    const dialog = getByRole("dialog", { name: "Command palette" });
    const input = getByRole("combobox", { name: "Search sessions, views and commands" });
    expect(dialog.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);

    press(input, { key: "Escape" });
    expect(queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens on ⌘K too", () => {
    const { getByRole, getByText } = renderApp();
    const opener = getByText("Old run").closest("button") as HTMLElement;
    opener.focus();
    press(opener, { key: "k", metaKey: true });
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("Escape closes the palette and leaves an open seat drawer open", () => {
    const { getByRole, queryByRole, store, container } = renderApp();
    act(() => {
      store.getState().select(sessionFixture.id);
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    const card = container.querySelector<HTMLElement>('[data-seat-id="executor"]')!;
    fireEvent.click(card);
    expect(getByRole("dialog", { name: "Executor" })).toBeTruthy();

    press(card, { key: "k", ctrlKey: true });
    press(field(), { key: "Escape" });
    expect(queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(getByRole("dialog", { name: "Executor" })).toBeTruthy();
  });

  it("ignores Escape and Enter while an IME composition is in progress", () => {
    const { getByRole, store, getByText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = field();

    press(input, { key: "Escape", isComposing: true });
    press(input, { key: "Enter", isComposing: true });
    press(input, { key: "Enter", keyCode: 229 });
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(store.getState().selectedId).toBeUndefined();
  });

  it("ignores a Ctrl+K that another handler already prevented", () => {
    const { queryByRole } = renderApp();
    const blocker = (event: globalThis.KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", blocker, true);
    try {
      press(document.body, { key: "k", ctrlKey: true });
    } finally {
      window.removeEventListener("keydown", blocker, true);
    }
    expect(queryByRole("dialog")).toBeNull();
  });

  it("a click on the backdrop closes the palette on mousedown; a click inside keeps focus on the input", () => {
    const { getByRole, queryByRole, getByText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = field();
    const dialog = getByRole("dialog", { name: "Command palette" });
    const option = within(getByRole("listbox")).getAllByRole("option")[0]!;

    // preventDefault on mousedown keeps focus where it is (fireEvent returns false when prevented).
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(fireEvent.mouseDown(dialog.querySelector(".palette-hint")!)).toBe(false);
    expect(fireEvent.mouseDown(input)).toBe(true);
    expect(document.activeElement).toBe(input);

    fireEvent.mouseDown(dialog.parentElement!);
    expect(queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});

describe("command palette: keyboard and results", () => {
  it("moves the highlight with arrows (aria-activedescendant) and Enter selects that run, closes, and focuses the main panel", () => {
    const { getByRole, store, getByText, container } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = getByRole("combobox", { name: "Search sessions, views and commands" });
    const listbox = getByRole("listbox");
    expect(optionLabels(listbox).slice(0, 2)).toEqual(["Implement average()", "Old run"]);

    press(input, { key: "ArrowDown" });
    const active = listbox.querySelector<HTMLElement>('[aria-selected="true"]')!;
    expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
    expect(active.textContent).toContain("Old run");

    press(input, { key: "Enter" });
    expect(store.getState().selectedId).toBe("old");
    expect(document.querySelector('[role="dialog"][aria-label="Command palette"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".main"));
  });

  it("filters by fuzzy match and shows no-match text when nothing fits", () => {
    const { getByRole, getByText, getByLabelText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = getByLabelText("Search sessions, views and commands") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "avg" } });
    const labels = optionLabels(getByRole("listbox"));
    expect(labels[0]).toBe("Implement average()");
    expect(labels).not.toContain("Old run");

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(getByRole("listbox").querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("No matches for “zzz”.");
  });

  it("lists recent runs first, once, and not again under Session", () => {
    const { getByRole, store, getByText } = renderApp();
    act(() => {
      store.getState().select("old");
      store.getState().select(sessionFixture.id);
    });
    expect(store.getState().recentIds).toEqual([sessionFixture.id, "old"]);

    openPalette(getByRole("button", { name: /Implement average/ }));
    const listbox = getByRole("listbox");
    const first = within(listbox).getAllByRole("option")[0]!;
    expect(first.textContent).toContain("Recent");
    expect(first.textContent).toContain("Implement average()");
    expect(optionLabels(listbox).filter((label) => label === "Old run")).toHaveLength(1);
    expect(getByText("Old run", { selector: ".palette-label" })).toBeTruthy();
  });

  it("draws at most MAX_RESULTS matches and says how many more there are", () => {
    const many: SessionSummary[] = Array.from({ length: 60 }, (_, i) => ({
      id: `run-${i}`,
      title: `Run ${i}`,
      hasLiveLog: false,
      lastSeq: 0,
    }));
    const { getByRole, getByText } = renderApp(many);
    openPalette(getByText("Run 0").closest("button") as HTMLElement);

    const listbox = getByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(MAX_RESULTS);
    // 60 runs and 6 write actions: 16 are not drawn.
    expect(within(getByRole("dialog", { name: "Command palette" })).getByRole("status").textContent).toBe(
      "16 more — keep typing to narrow the results",
    );
  });

  it("option ids come from the item, so the highlight is named after the entry", () => {
    const { getByRole, getByText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    fireEvent.change(field(), { target: { value: "pause" } });
    const option = getByRole("option", { name: /Pause the run/ });
    expect(option.id).toMatch(/write_pause$/);
    expect(field().getAttribute("aria-activedescendant")).toBe(option.id);
  });
});

describe("command palette: write actions and views", () => {
  it("shows /pause disabled with its reason, and does nothing on Enter", () => {
    const { getByRole, store, getByText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = field();

    fireEvent.change(input, { target: { value: "pause" } });
    const option = getByRole("option", { name: /Pause the run/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(PAUSE_REASON);
    const reason = document.getElementById(option.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe(PAUSE_REASON);

    press(input, { key: "Enter" });
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(store.getState().selectedId).toBeUndefined();
    expect(within(getByRole("dialog", { name: "Command palette" })).getByRole("status").textContent).toContain(PAUSE_REASON);

    fireEvent.click(option);
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(store.getState().selectedId).toBeUndefined();
  });

  it("lists the views that are on screen and moves focus to one when run", () => {
    const { getByRole, queryByRole, store, container } = renderApp();
    act(() => {
      store.getState().select(sessionFixture.id);
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    const board = container.querySelector<HTMLElement>(".seat-board")!;
    expect(board).toBeTruthy();

    openPalette(getByRole("button", { name: /Implement average/ }));
    fireEvent.change(field(), { target: { value: "session board" } });
    press(field(), { key: "Enter" });

    expect(queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(document.activeElement).toBe(board);
    expect(board.getAttribute("tabindex")).toBe("-1");
  });
});

describe("keyboard map and platform labels", () => {
  it("shows Ctrl+K on other platforms and ⌘K on macOS, in the palette hint and the ? dialog", () => {
    const { getByText, getByRole, queryByRole, unmount } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    expect(document.querySelector(".palette-hint")?.textContent).toContain("Ctrl+K");
    press(document.activeElement ?? document, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    unmount();
    cleanup();

    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    const mac = renderApp();
    fireEvent.click(mac.getByText("Shortcuts"));
    const help = mac.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("⌘K")).toBeTruthy();
    expect(within(help).queryByText("Ctrl+K")).toBeNull();
    expect(getByRole).toBeTruthy();
  });

  it("? opens the keyboard map; a click in it keeps focus on Close; Escape closes it and returns focus to the Shortcuts button", () => {
    const { getByRole, queryByRole, getByText } = renderApp();
    const shortcuts = getByText("Shortcuts");
    shortcuts.focus();
    press(shortcuts, { key: "?", shiftKey: true });

    const help = getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("Open the command palette")).toBeTruthy();
    expect(within(help).getByText("Show this keyboard map")).toBeTruthy();

    const close = within(help).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    expect(fireEvent.mouseDown(within(help).getByText("Show this keyboard map"))).toBe(false);
    expect(fireEvent.mouseDown(close)).toBe(true);
    expect(document.activeElement).toBe(close);

    press(close, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(shortcuts);
  });

  it("a click on the keyboard map backdrop closes it", () => {
    const { getByRole, queryByRole, getByText } = renderApp();
    fireEvent.click(getByText("Shortcuts"));
    fireEvent.mouseDown(getByRole("dialog", { name: "Keyboard shortcuts" }).parentElement!);
    expect(queryByRole("dialog")).toBeNull();
  });

  it("ignores ? while typing in a select, and ignores Ctrl+K in a textarea; Ctrl+K from the select still opens the palette", () => {
    const { queryByRole, container, getByRole } = renderApp();
    const select = container.querySelector("select")!;
    select.focus();
    press(select, { key: "?", shiftKey: true });
    expect(queryByRole("dialog")).toBeNull();
    press(select, { key: "k", ctrlKey: true });
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    press(field(), { key: "Escape" });

    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    press(area, { key: "?", shiftKey: true });
    press(area, { key: "k", metaKey: true });
    expect(queryByRole("dialog")).toBeNull();
    area.remove();
  });
});
