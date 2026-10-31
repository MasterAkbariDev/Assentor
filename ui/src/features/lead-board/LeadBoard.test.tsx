// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { App } from "../../App.js";
import { renderWithStore } from "../../test/render.js";
import { leadFixture, sessionFixture } from "../../test/fixtures.js";
import { parseEngineEvent } from "@engine/protocol/events.js";
import { SeatDrawer } from "../seat-drawer/SeatDrawer.js";
import { LeadBoard } from "./LeadBoard.js";

afterEach(() => cleanup());

/** The team board with the lead-mode fixture run selected and applied. */
function renderLeadBoard(withDrawer = false) {
  const rendered = renderWithStore(
    <>
      <LeadBoard />
      {withDrawer ? <SeatDrawer /> : null}
    </>,
  );
  act(() => {
    rendered.store.getState().select(leadFixture.id);
    rendered.store.getState().applyEvents(leadFixture.id, leadFixture.events);
  });
  return rendered;
}

describe("LeadBoard: stage columns", () => {
  it("shows the six stages as labelled regions, each task in its stage", () => {
    const { getByRole, queryByRole } = renderLeadBoard();
    const stageNames = ["Backlog", "Assigned", "In progress", "In review", "Accepted", "Rejected"];
    for (const name of stageNames) {
      expect(getByRole("region", { name })).toBeTruthy();
    }
    expect(queryByRole("region", { name: "Done" })).toBeNull();

    const taskIds = (name: string) =>
      within(getByRole("region", { name })).queryAllByText(/^T\d$/).map((el) => el.textContent);
    expect(taskIds("Backlog")).toEqual(["T5"]);
    expect(taskIds("Assigned")).toEqual(["T4"]);
    expect(taskIds("In progress")).toEqual(["T1"]);
    expect(taskIds("In review")).toEqual(["T2"]);
    expect(taskIds("Accepted")).toEqual(["T3"]);
    expect(within(getByRole("region", { name: "Rejected" })).getByText("No tasks")).toBeTruthy();
  });

  it("shows the turn, the owner's name, model and live status, and the reassign and escalation counters", () => {
    const { getByRole, getByText } = renderLeadBoard();
    expect(getByRole("heading", { level: 2, name: /Team board/ }).textContent).toContain("turn 1");
    const t4 = getByRole("button", { name: /T4 Refactor auth/ });
    expect(t4.textContent).toContain("Sonnet#2");
    expect(t4.textContent).toContain("sonnet");
    expect(t4.textContent).toContain("Reassigned 1 · Escalated 1");
    expect(getByText("Login API")).toBeTruthy();
  });

  it("renders task and model text as text, never as HTML", () => {
    const { store, container, getByText } = renderLeadBoard();
    act(() => {
      store.getState().applyEvents(leadFixture.id, [
        parseEngineEvent({
          seq: 999,
          sessionId: leadFixture.id,
          type: "task.created",
          data: { taskId: "T9", title: "<img src=x onerror=alert(1)>", replaced: false },
          at: new Date(0).toISOString(),
        }),
      ]);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});

describe("LeadBoard: lead log", () => {
  it("lists every lead action with its mark and reason", () => {
    const { getByRole } = renderLeadBoard();
    const log = within(getByRole("region", { name: "Lead log" }));
    const items = log.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toContain("Accepted:");
    expect(items[0]!.textContent).toContain("plan_tasks");
    expect(items[2]!.textContent).toContain("Refused:");
    expect(items[2]!.textContent).toContain("seat-1 is busy with another task");
  });

  it("the refused-actions switch narrows the log to refused actions and back", () => {
    const { getByRole } = renderLeadBoard();
    const log = within(getByRole("region", { name: "Lead log" }));
    const toggle = getByRole("switch", { name: "Refused only" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    const refused = log.getAllByRole("listitem");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.textContent).toContain("assign");

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(log.getAllByRole("listitem")).toHaveLength(4);
  });
});

describe("LeadBoard: org chart", () => {
  it("shows the lead with each seat under it, with the seat's live status", () => {
    const { getByRole, store } = renderLeadBoard();
    const chart = within(getByRole("region", { name: "Org chart" }));
    const seats = chart.getByRole("list", { name: "Seats" });
    const nodes = within(seats).getAllByRole("listitem");
    expect(nodes.map((n) => n.textContent)).toEqual([
      expect.stringContaining("writing"),
      expect.stringContaining("queued"),
    ]);
    expect(nodes[0]!.textContent).toContain("Opus#1");

    act(() => {
      store.getState().applyEvents(leadFixture.id, [
        parseEngineEvent({
          seq: 1000,
          sessionId: leadFixture.id,
          seatId: "seat-2",
          type: "seat.status",
          data: { status: "thinking" },
          at: new Date(0).toISOString(),
        }),
      ]);
    });
    expect(within(seats).getAllByRole("listitem")[1]!.textContent).toContain("thinking");
  });
});

describe("LeadBoard: opening the owner's seat drawer", () => {
  it("clicking a card with an owner opens that seat's drawer; an unassigned card is plain text", () => {
    const { getByRole, queryByRole } = renderLeadBoard(true);
    fireEvent.click(getByRole("button", { name: /T1 Login form/ }));
    expect(getByRole("dialog", { name: "Opus#1" })).toBeTruthy();

    expect(queryByRole("button", { name: /T5 Release notes/ })).toBeNull();
    expect(getByRole("region", { name: "Backlog" }).textContent).toContain("Unassigned");
  });
});

describe("App: the team board appears only for a lead-mode run", () => {
  it("shows the board for a lead run and not for a solo run", () => {
    const { store, queryByRole, getByRole } = renderWithStore(<App />);
    act(() => {
      store.getState().setConnection("connected");
      store.getState().setSessions([
        { id: leadFixture.id, title: "Login feature", status: "EXECUTING", hasLiveLog: true, lastSeq: 27 },
        { id: sessionFixture.id, title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 16 },
      ]);
      store.getState().select(sessionFixture.id);
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    expect(queryByRole("region", { name: "Team board" })).toBeNull();

    act(() => {
      store.getState().select(leadFixture.id);
      store.getState().applyEvents(leadFixture.id, leadFixture.events);
    });
    expect(getByRole("region", { name: "Team board" })).toBeTruthy();
  });
});
