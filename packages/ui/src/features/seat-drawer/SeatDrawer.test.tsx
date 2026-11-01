// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import type { Transport } from "../../transport/types.js";
import { mockTransport } from "../../transport/mock.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { SessionBoard } from "../session-board/SessionBoard.js";
import { SeatDrawer } from "./SeatDrawer.js";

afterEach(() => cleanup());

/** The board and the drawer, with the shared fixture run selected and applied. */
function renderPanel() {
  return renderPanelWith();
}

function renderPanelWith(transport?: Transport) {
  const rendered = renderWithStore(
    <>
      <SessionBoard />
      <SeatDrawer />
    </>,
    undefined,
    transport,
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
    expect(tab(dialog, "Files").getAttribute("aria-selected")).toBe("true");
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
    for (const name of ["Transcript", "Output", "Files", "Info"]) {
      expect(tab(dialog, name).tabIndex).toBe(-1);
    }
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

describe("SeatDrawer: Output follow-tail and colours", () => {
  const spawn = { displayName: "Executor", provider: "mock", transport: "api", model: "AUTO", role: "engineer", permissions: "edit" };
  function renderOutput(texts: string[]) {
    const id = "ansi-run";
    const rendered = renderWithStore(
      <>
        <SessionBoard />
        <SeatDrawer />
      </>,
    );
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    const ev = (seq: number, type: string, data: unknown) => ({ seq, sessionId: id, seatId: "executor", at, type, data }) as EngineEvent;
    act(() => {
      rendered.store.getState().select(id);
      rendered.store.getState().applyEvents(id, [ev(1, "seat.spawned", spawn), ...texts.map((t, i) => ev(i + 2, "seat.output.delta", { text: t }))]);
    });
    fireEvent.click(cardFor(rendered.container, "executor"));
    fireEvent.click(rendered.getByRole("tab", { name: "Output" }));
    let seq = 100;
    const more = (text: string) =>
      act(() => rendered.store.getState().applyEvents(id, [ev(++seq, "seat.output.delta", { text })]));
    return { ...rendered, more, pre: () => rendered.getByRole("tabpanel").querySelector("pre") as HTMLPreElement };
  }
  const geometry = (pre: HTMLPreElement, scrollTop: number) =>
    Object.defineProperties(pre, {
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: scrollTop, writable: true, configurable: true },
    });

  it("renders colour codes as styled spans without the escape characters", () => {
    const { pre } = renderOutput(["\u001b[31mred\u001b[0m plain \u001b[1;38;5;196mhot\u001b[0m <b>x</b>"]);
    const spans = Array.from(pre().querySelectorAll("span"));
    expect(spans.map((s) => s.textContent)).toEqual(["red", " plain ", "hot", " <b>x</b>"]);
    expect(spans[0]!.style.color).not.toBe("");
    expect(spans[2]!.style.fontWeight).toBe("700");
    expect(pre().querySelector("b")).toBeNull();
    expect(pre().textContent).not.toContain("\u001b");
  });

  it("follows new output while at the bottom, and stays put once the reader scrolled up", () => {
    const { pre, more, getByRole } = renderOutput(["one\n"]);
    const el = geometry(pre(), 400); // at the bottom
    fireEvent.scroll(el);
    more("two\n");
    expect(el.scrollTop).toBe(500);

    el.scrollTop = 0;
    fireEvent.scroll(el); // scrolled up
    more("three\n");
    expect(el.scrollTop).toBe(0);
    expect(getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });
});

describe("SeatDrawer: Transcript", () => {
  it("lists tool calls with their args, a file link to the diff view, and results", () => {
    const { container, getByRole } = renderPanel();
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Transcript" }));
    const list = getByRole("list", { name: "Transcript" });
    const rows = Array.from(list.querySelectorAll("li")).map((li) => li.querySelector(".seat-activity-text")!.textContent);
    expect(rows).toEqual(["editing src/average.ts", "average() added"]);
    const link = within(list).getByRole("link", { name: "src/average.ts" });
    expect(link.getAttribute("href")).toBe("#/sessions?diff=src%2Faverage.ts&seat=executor");
  });

  it("shows only the last rows and loads earlier ones on request", () => {
    const id = "long-run";
    const { store, container, getByRole, queryByRole } = renderWithStore(
      <>
        <SessionBoard />
        <SeatDrawer />
      </>,
    );
    const at = new Date(Date.UTC(2026, 9, 25, 10, 0, 0)).toISOString();
    const events = [
      { seq: 1, sessionId: id, seatId: "a", at, type: "seat.spawned", data: { displayName: "A", provider: "mock", transport: "api", model: "AUTO", role: "x", permissions: "edit" } },
      ...Array.from({ length: 120 }, (_, i) => ({ seq: i + 2, sessionId: id, seatId: "a", at, type: "seat.tool_call", data: { name: "read", summary: `call ${i}` } })),
    ] as EngineEvent[];
    act(() => {
      store.getState().select(id);
      store.getState().applyEvents(id, events);
    });
    fireEvent.click(cardFor(container, "a"));
    fireEvent.click(getByRole("tab", { name: "Transcript" }));
    const count = () => getByRole("list", { name: "Transcript" }).querySelectorAll("li").length;
    expect(count()).toBe(50);
    fireEvent.click(getByRole("button", { name: "Show earlier (70)" }));
    expect(count()).toBe(100);
    fireEvent.click(getByRole("button", { name: "Show earlier (20)" }));
    expect(count()).toBe(120);
    expect(queryByRole("button", { name: /Show earlier/ })).toBeNull();
  });
});

describe("SeatDrawer: Files", () => {
  const diff = { baseSha: "a".repeat(40), head: "b".repeat(40), dirty: true, files: ["src/a.ts", "docs/b.md"], diff: "", truncated: false };

  it("lists the worktree's files with links to the diff view", async () => {
    const transport = mockTransport({ handlers: { "worktree.diff": () => diff } });
    const { container, findByRole, getByRole } = renderPanelWith(transport);
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Files" }));
    const list = await findByRole("list", { name: "Files" });
    const links = Array.from(list.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual(["src/a.ts", "docs/b.md"]);
    expect(links[1]!.getAttribute("href")).toBe("#/sessions?diff=docs%2Fb.md&seat=executor");
    expect(transport.calls.some((c) => c.method === "worktree.diff")).toBe(true);
  });

  it("falls back to files named in tool calls when the seat has no worktree", async () => {
    const transport = mockTransport({
      handlers: {
        "worktree.diff": () => {
          throw new Error("No worktree for seat");
        },
      },
    });
    const { container, findByRole, getByRole } = renderPanelWith(transport);
    fireEvent.click(cardFor(container, "executor"));
    fireEvent.click(getByRole("tab", { name: "Files" }));
    const list = await findByRole("list", { name: "Files" });
    expect(list.textContent).toBe("src/average.ts");
    expect(getByRole("note").textContent).toContain("no worktree");
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
    for (const name of ["Activity", "Transcript", "Files", "Output", "Info"]) {
      fireEvent.click(getByRole("tab", { name }));
      expect(document.querySelectorAll("[style]")).toHaveLength(0);
    }
  });
});
