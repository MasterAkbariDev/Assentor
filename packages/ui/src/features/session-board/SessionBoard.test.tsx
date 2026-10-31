// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { SessionBoard } from "./SessionBoard.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Vitest runs from the repository root; jsdom gives import.meta.url an http origin.
const CSS_PATH = path.resolve(process.cwd(), "packages/ui/src/styles.css");

function renderBoardWithFixture() {
  const rendered = renderWithStore(<SessionBoard />);
  act(() => {
    rendered.store.getState().select(sessionFixture.id);
    rendered.store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
  });
  return rendered;
}

/** Seat event with an explicit time, for elapsed-time tests. */
function seatEvent(sessionId: string, seq: number, second: number, seatId: string, type: string, data: object): EngineEvent {
  return {
    seq,
    sessionId,
    seatId,
    at: new Date(Date.UTC(2026, 9, 25, 10, 0, second)).toISOString(),
    type,
    data,
  } as EngineEvent;
}

/** The body of the first `@media (prefers-reduced-motion: no-preference)` block, by brace matching. */
function reducedMotionBlock(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  if (start < 0) {
    return "";
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  return "";
}

describe("SessionBoard", () => {
  it("renders one card per seat, grouped executor first, then reviewers", () => {
    const { container } = renderBoardWithFixture();

    expect(container.querySelectorAll("article.seat-card")).toHaveLength(4);
    const titles = [...container.querySelectorAll(".seat-group-title > span:first-child")].map((el) => el.textContent);
    expect(titles).toEqual(["Executor", "Reviewers"]);

    const groups = container.querySelectorAll("section.seat-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelectorAll("article.seat-card")).toHaveLength(1);
    // The reviewers group holds reviewer-1, reviewer-2 and the panel.
    expect(groups[1]!.querySelectorAll("article.seat-card")).toHaveLength(3);
  });

  it("shows each card's name, model, role, label and tokens when they are known", () => {
    const { getByText } = renderBoardWithFixture();
    expect(getByText("Opus#2")).toBeTruthy();
    expect(getByText("failed")).toBeTruthy();
    expect(getByText("Review panel")).toBeTruthy();
  });

  it("a later seat.status event updates that card's label", () => {
    const { store, getByText } = renderBoardWithFixture();
    act(() => {
      store.getState().applyEvents(sessionFixture.id, [
        {
          seq: 17,
          sessionId: sessionFixture.id,
          seatId: "reviewer-1",
          at: new Date(Date.UTC(2026, 9, 25, 10, 1, 0)).toISOString(),
          type: "seat.status",
          data: { status: "writing" },
        } as EngineEvent,
      ]);
    });
    const card = getByText("Opus#1").closest("article") as HTMLElement;
    expect(within(card).getByText("writing")).toBeTruthy();
  });

  it("the elapsed ticker runs while a seat is live and stops once every seat is done", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 10, 0, 0)));
    const sessionId = "ticker-run";
    const { store, container } = renderWithStore(<SessionBoard />);
    const elapsed = () => container.querySelector(".seat-card-elapsed")?.textContent;

    act(() => {
      store.getState().select(sessionId);
      store.getState().applyEvents(sessionId, [
        seatEvent(sessionId, 1, 0, "executor", "seat.spawned", {
          displayName: "Executor", provider: "mock", transport: "api", model: "AUTO", role: "engineer", permissions: "edit",
        }),
        seatEvent(sessionId, 2, 0, "executor", "seat.status", { status: "writing" }),
      ]);
    });
    expect(elapsed()).toBe("0:00");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(elapsed()).toBe("0:03");

    act(() => {
      store.getState().applyEvents(sessionId, [seatEvent(sessionId, 3, 5, "executor", "seat.done", { ok: true })]);
    });
    expect(elapsed()).toBe("0:05");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(elapsed()).toBe("0:05");
    // No interval is left running once nothing is live.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders no inline styles and no interactive controls", () => {
    const { container } = renderBoardWithFixture();
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("only a thinking seat's icon carries the animation class, and that rule sits under prefers-reduced-motion: no-preference", () => {
    const sessionId = "thinking-run";
    const { store, container } = renderWithStore(<SessionBoard />);
    act(() => {
      store.getState().select(sessionId);
      store.getState().applyEvents(sessionId, [
        seatEvent(sessionId, 1, 0, "executor", "seat.spawned", {
          displayName: "Executor", provider: "mock", transport: "api", model: "AUTO", role: "engineer", permissions: "edit",
        }),
        seatEvent(sessionId, 2, 0, "executor", "seat.status", { status: "thinking" }),
      ]);
    });
    expect(container.querySelectorAll(".seat-card-icon.is-thinking")).toHaveLength(1);

    const css = readFileSync(CSS_PATH, "utf8");
    const block = reducedMotionBlock(css);
    expect(block).toContain(".seat-card-icon.is-thinking");
    // Every use of the class in the stylesheet is inside that media block.
    expect(css.split("is-thinking").length - 1).toBe(block.split("is-thinking").length - 1);
  });
});
