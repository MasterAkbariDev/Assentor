// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import type { StageView } from "../../store/stages.js";
import { StageRail } from "./StageRail.js";
import { SessionBoard } from "./SessionBoard.js";
import { liveRun } from "./boardTestUtil.js";
import { render } from "@testing-library/react";

afterEach(cleanup);

describe("StageRail", () => {
  it("shows done, running, pending and failed stages in order, each with an icon and a word", () => {
    const stages: StageView[] = [
      { id: "plan", kind: "negotiate", strategy: "debate", attempt: 1, status: "done", outcome: "pass" },
      { id: "build", kind: "execute", attempt: 2, status: "running" },
      { id: "ship", kind: "review", attempt: 1, status: "pending" },
      { id: "x", kind: "negotiate", strategy: "vote", attempt: 1, status: "failed", outcome: "budget" },
    ];
    const { getByRole } = render(<StageRail stages={stages} />);
    const items = within(getByRole("list", { name: "Stages" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "✓negotiate · debatedone",
      "●execute · attempt 2running",
      "○reviewpending",
      "✗negotiate · voteover budget",
    ]);
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
  });

  it("renders nothing for a run without stages", () => {
    const { container } = render(<StageRail stages={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("follows stage events from the store; a solo run shows no rail", () => {
    const id = "stage-run";
    const { store, container, queryByRole, getByRole } = renderWithStore(<SessionBoard />);
    const stage = (seq: number, type: string, stageId: string, data: object) =>
      ({ seq: 100 + seq, sessionId: id, stageId, at: new Date(Date.UTC(2026, 9, 25, 11, 0, seq)).toISOString(), type, data }) as EngineEvent;
    act(() => {
      store.getState().select(id);
      store.getState().applyEvents(id, liveRun(id));
    });
    expect(queryByRole("list", { name: "Stages" })).toBeNull();
    expect(container.querySelector(".stage-rail")).toBeNull();

    act(() => store.getState().applyEvents(id, [stage(1, "stage.started", "s1", { kind: "negotiate", strategy: "debate", attempt: 1 })]));
    expect(getByRole("list", { name: "Stages" }).textContent).toBe("●negotiate · debaterunning");

    act(() =>
      store.getState().applyEvents(id, [
        stage(2, "stage.completed", "s1", { kind: "negotiate", strategy: "debate", attempt: 1, outcome: "pass", summary: "ok" }),
        stage(3, "stage.started", "s2", { kind: "execute", attempt: 1 }),
        stage(4, "stage.completed", "s2", { kind: "execute", attempt: 1, outcome: "needs_work", summary: "again" }),
        stage(5, "stage.started", "s2", { kind: "execute", attempt: 2 }),
      ]),
    );
    const items = within(getByRole("list", { name: "Stages" })).getAllByRole("listitem");
    // The retry reuses the stage's place and shows the new attempt.
    expect(items.map((li) => li.textContent)).toEqual(["✓negotiate · debatedone", "●execute · attempt 2running"]);

    act(() => store.getState().applyEvents(id, [stage(6, "stage.completed", "s2", { kind: "execute", attempt: 2, outcome: "needs_work", summary: "x" })]));
    expect(getByRole("list", { name: "Stages" }).lastElementChild!.textContent).toBe("✗execute · attempt 2needs work");
  });
});
