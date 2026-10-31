// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { SessionBoard } from "../session-board/SessionBoard.js";
import { SeatDrawer } from "./SeatDrawer.js";

afterEach(() => cleanup());

/** The board and the drawer, with the shared fixture run selected and applied. */
function renderPanel() {
  const rendered = renderWithStore(
    <>
      <SessionBoard />
      <SeatDrawer />
    </>,
  );
  act(() => {
    rendered.store.getState().select(sessionFixture.id);
    rendered.store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
  });
  return rendered;
}

function cardFor(container: HTMLElement, seatId: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`);
  if (!card) throw new Error(`no card for ${seatId}`);
  return card;
}

function tab(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole("tab", { name });
}

/** The value next to a label in the Info tab's definition list. */
function infoValue(dialog: HTMLElement, label: string): string | null | undefined {
  const dt = Array.from(dialog.querySelectorAll("dt")).find((el) => el.textContent === label);
  return dt?.nextElementSibling?.textContent;
}

describe("SeatDrawer: opening and closing", () => {
  it("opens by click, is named after the seat, and closes with the button, returning focus to the card", () => {
    const { container, getByRole, queryByRole } = renderPanel();
    const card = cardFor(container, "reviewer-1");

    fireEvent.click(card);
    const dialog = getByRole("dialog", { name: "Opus#1" });
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("opens with Enter and with Space from the keyboard", () => {
    const { container, getByRole, queryByRole } = renderPanel();
    const card = cardFor(container, "executor");
    card.focus();

    fireEvent.keyDown(card, { key: "Enter" });
    expect(getByRole("dialog", { name: "Executor" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(card, { key: " " });
    expect(getByRole("dialog", { name: "Executor" })).toBeTruthy();
  });

  it("Escape closes the drawer and restores focus to the card that opened it", () => {
    const { container, queryByRole } = renderPanel();
    const card = cardFor(container, "executor");
    fireEvent.click(card);
    expect(document.activeElement).not.toBe(card);

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("each card is a keyboard-focusable role=button, and the board has no native buttons", () => {
    const { container } = renderPanel();
    for (const card of container.querySelectorAll<HTMLElement>("[data-seat-id]")) {
      expect(card.getAttribute("role")).toBe("button");
      expect(card.tabIndex).toBe(0);
    }
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("SeatDrawer: tabs", () => {
  it("switches tabs by click and by arrow keys, Home and End, and wraps around", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    const dialog = getByRole("dialog");
    const tablist = getByRole("tablist");
    expect(tab(dialog, "Activity").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(tab(dialog, "Output"));
    expect(tab(dialog, "Output").getAttribute("aria-selected")).toBe("true");
    expect(getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tab(dialog, "Output").id);

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(tab(dialog, "Info").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(dialog, "Info"));

    fireEvent.keyDown(tablist, { key: "ArrowRight" }); // wraps to Activity
    expect(tab(dialog, "Activity").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "ArrowLeft" }); // wraps to Info
    expect(tab(dialog, "Info").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(tab(dialog, "Activity").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "End" });
    expect(tab(dialog, "Info").getAttribute("aria-selected")).toBe("true");
  });

  it("only the selected tab is in the tab order", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    const dialog = getByRole("dialog");
    expect(tab(dialog, "Activity").tabIndex).toBe(0);
    expect(tab(dialog, "Output").tabIndex).toBe(-1);
    expect(tab(dialog, "Info").tabIndex).toBe(-1);
  });
});

describe("SeatDrawer: Activity", () => {
  it("lists this seat's events in order and nothing from other seats", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    const rows = Array.from(getByRole("list", { name: "Activity" }).querySelectorAll(".seat-activity-text")).map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["starting", "writing", "tool editing: src/average.ts", "done: average() added"]);
    expect(rows.join("\n")).not.toContain("Looks correct");
  });

  it("shows the reviewer's failure and its own rows only", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "reviewer-2"));
    const rows = Array.from(getByRole("list", { name: "Activity" }).querySelectorAll(".seat-activity-text")).map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["starting", "error: timed out"]);
  });
});

describe("SeatDrawer: Output", () => {
  it("shows the output tail as plain text, so a script tag stays literal", () => {
    const id = "xss-run";
    const { store, container, getByRole } = renderWithStore(
      <>
        <SessionBoard />
        <SeatDrawer />
      </>,
    );
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    act(() => {
      store.getState().select(id);
      store.getState().applyEvents(id, [
        { seq: 1, sessionId: id, seatId: "executor", at, type: "seat.spawned", data: { displayName: "Executor", provider: "mock", transport: "api", model: "AUTO", role: "engineer", permissions: "edit" } } as EngineEvent,
        { seq: 2, sessionId: id, seatId: "executor", at, type: "seat.output.delta", data: { text: '<script>alert("x")</script>\n' } } as EngineEvent,
      ]);
    });
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Output" }));

    const panel = getByRole("tabpanel");
    expect(panel.querySelectorAll("script")).toHaveLength(0);
    expect(panel.querySelector("pre")!.textContent).toBe('<script>alert("x")</script>\n');
  });

  it("shows the fixture's output in a pre element", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Output" }));
    expect(getByRole("tabpanel").querySelector("pre")!.textContent).toBe("Reading src/average.ts\nAdding average()\n");
  });

  it("offers Jump to latest after the reader scrolls up, and scrolls to the end when used", () => {
    const { container, getByRole, queryByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Output" }));
    const pre = getByRole("tabpanel").querySelector("pre") as HTMLPreElement;
    Object.defineProperties(pre, {
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });

    expect(queryByRole("button", { name: "Jump to latest" })).toBeNull();
    fireEvent.scroll(pre); // 400px above the bottom: the reader scrolled up
    fireEvent.click(getByRole("button", { name: "Jump to latest" }));
    expect(pre.scrollTop).toBe(500);
    expect(queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});

describe("SeatDrawer: Info", () => {
  it("shows provider, transport and permissions from seat.spawned, plus ids and status", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Info" }));
    const dialog = getByRole("dialog");
    expect(infoValue(dialog, "Provider")).toBe("mock");
    expect(infoValue(dialog, "Transport")).toBe("api");
    expect(infoValue(dialog, "Permissions")).toBe("edit");
    expect(infoValue(dialog, "Model")).toBe("AUTO");
    expect(infoValue(dialog, "Role")).toBe("engineer");
    expect(infoValue(dialog, "Status")).toBe("done");
    expect(infoValue(dialog, "Seat id")).toBe("executor");
    expect(infoValue(dialog, "Session id")).toBe(sessionFixture.id);
  });

  it("renders no inline style attributes anywhere in the panel", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    for (const name of ["Activity", "Output", "Info"]) {
      fireEvent.click(getByRole("tab", { name }));
      expect(document.querySelectorAll("[style]")).toHaveLength(0);
    }
  });
});
