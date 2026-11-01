// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { liveRun } from "./boardTestUtil.js";

// A card calls seatLineModel once per render, so its calls count that card's renders.
const renders: string[] = [];
vi.mock("#assentor/ui-shared/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#assentor/ui-shared/status.js")>();
  return { ...actual, seatLineModel: (seat: { seatId: string }, now: number) => (renders.push(seat.seatId), actual.seatLineModel(seat as never, now)) };
});

import { SessionBoard } from "./SessionBoard.js";

afterEach(cleanup);

describe("SeatCard render count", () => {
  it("a status change on one seat renders only that card", () => {
    const id = "render-run";
    const { store } = renderWithStore(<SessionBoard />);
    act(() => {
      store.getState().select(id);
      store.getState().applyEvents(id, liveRun(id));
    });
    renders.length = 0;

    act(() =>
      store.getState().applyEvents(id, [
        { seq: 99, sessionId: id, seatId: "reviewer-1", at: new Date(Date.UTC(2026, 9, 25, 10, 5, 0)).toISOString(), type: "seat.status", data: { status: "thinking" } } as EngineEvent,
      ]),
    );
    expect(renders).toEqual(["reviewer-1"]);
  });
});
