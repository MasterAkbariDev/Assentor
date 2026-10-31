// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { App } from "../../App.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { WRITE_REASON } from "./items.js";

afterEach(() => {
  cleanup();
  delete (window.navigator as unknown as { platform?: string }).platform;
});

/** The app with two runs listed; the fixture run (which has seats) is not selected yet. */
function renderApp() {
  const rendered = renderWithStore(<App />);
  act(() => {
    rendered.store.getState().setConnection("connected", "0.4.0");
    rendered.store.getState().setSessions([
      { id: sessionFixture.id, title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 16 },
      { id: "old", title: "Old run", status: "DONE", hasLiveLog: false, lastSeq: 0 },
    ]);
  });
  return rendered;
}

/** Focus `el` (what the user had) and press a key on it. */
function press(el: Element | Document, init: KeyboardEventInit) {
  fireEvent.keyDown(el, { ...init });
}

function openPalette(opener: HTMLElement) {
  opener.focus();
  press(opener, { key: "k", ctrlKey: true });
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
    const input = getByRole("combobox", { name: "Search sessions, views and commands" });
    press(input, { key: "Escape" });
    expect(queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(getByRole("dialog", { name: "Executor" })).toBeTruthy();
  });
});

describe("command palette: keyboard and results", () => {
  it("moves the highlight with arrows (aria-activedescendant) and Enter selects that run and closes", () => {
    const { getByRole, store, getByText } = renderApp();
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
  });

  it("filters by fuzzy match and shows no-match text when nothing fits", () => {
    const { getByRole, queryByRole, getByText, getByLabelText } = renderApp();
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

  it("lists recent runs first once a run has been selected", () => {
    const { getByRole, store } = renderApp();
    act(() => {
      store.getState().select("old");
      store.getState().select(sessionFixture.id);
    });
    expect(store.getState().recentIds).toEqual([sessionFixture.id, "old"]);

    openPalette(getByRole("button", { name: /Implement average/ }));
    const first = getByRole("listbox").querySelector('[role="option"]')!;
    expect(first.textContent).toContain("Recent");
    expect(first.textContent).toContain("Implement average()");
  });
});

describe("command palette: write actions and views", () => {
  it("shows /model, /pause, /inject and /approve disabled with the reason, and does nothing on Enter", () => {
    const { getByRole, store, getByText, getByLabelText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    const input = getByLabelText("Search sessions, views and commands") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "pause" } });
    const option = getByRole("option", { name: /Pause the run/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(WRITE_REASON);

    press(input, { key: "Enter" });
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(store.getState().selectedId).toBeUndefined();
    expect(within(getByRole("dialog", { name: "Command palette" })).getByRole("status").textContent).toContain(WRITE_REASON);

    fireEvent.click(option);
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(store.getState().selectedId).toBeUndefined();
  });

  it("lists the views that are on screen and moves focus to one when run", () => {
    const { getByRole, queryByRole, store, getByLabelText, container, getByText } = renderApp();
    openPalette(getByText("Old run").closest("button") as HTMLElement);
    press(getByLabelText("Search sessions, views and commands"), { key: "Escape" });

    act(() => {
      store.getState().select(sessionFixture.id);
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    const board = container.querySelector<HTMLElement>(".seat-board")!;
    expect(board).toBeTruthy();

    openPalette(getByRole("button", { name: /Implement average/ }));
    const input = getByLabelText("Search sessions, views and commands") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "session board" } });
    press(input, { key: "Enter" });

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
  });

  it("? opens the keyboard map, and Escape closes it and returns focus to the Shortcuts button", () => {
    const { getByRole, queryByRole, getByText } = renderApp();
    const shortcuts = getByText("Shortcuts");
    shortcuts.focus();
    press(shortcuts, { key: "?", shiftKey: true });

    const help = getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("Open the command palette")).toBeTruthy();
    expect(within(help).getByText("Show this keyboard map")).toBeTruthy();

    press(within(help).getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(shortcuts);
  });

  it("ignores Ctrl+K and ? while typing in a field", () => {
    const { queryByRole, container } = renderApp();
    const select = container.querySelector("select")!;
    select.focus();
    press(select, { key: "k", ctrlKey: true });
    press(select, { key: "?", shiftKey: true });
    expect(queryByRole("dialog")).toBeNull();

    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    press(area, { key: "?", shiftKey: true });
    press(area, { key: "k", metaKey: true });
    expect(queryByRole("dialog")).toBeNull();
    area.remove();
  });
});
