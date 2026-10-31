// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { EngineEvent } from "@engine/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { negotiationFixture, sessionFixture } from "../../test/fixtures.js";
import { selectHasNegotiation } from "../../store/selectors.js";
import { NegotiationView } from "./NegotiationView.js";

afterEach(() => cleanup());

/** The view with the negotiation fixture selected and applied. */
function renderFixture() {
  const rendered = renderWithStore(<NegotiationView />);
  act(() => {
    rendered.store.getState().select(negotiationFixture.id);
    rendered.store.getState().applyEvents(negotiationFixture.id, negotiationFixture.events);
  });
  return rendered;
}

/** Choose the debate run (the view opens on the last run, the vote). */
function selectDebateRun(container: HTMLElement) {
  const select = container.querySelector("select") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: select.options[0]!.value } });
}

function roundTab(container: HTMLElement, round: number): HTMLElement {
  const tab = within(container).getByRole("tab", { name: `Round ${round}` });
  fireEvent.click(tab);
  return tab;
}

function switchButton(container: HTMLElement): HTMLElement {
  return within(container).getByRole("switch", { name: "Reveal authors" });
}

describe("NegotiationView: rounds and proposals", () => {
  it("opens on the last run and its last round, with one tab per round", () => {
    const { container, getByRole } = renderFixture();
    expect(getByRole("tablist", { name: "Rounds" })).toBeTruthy();
    expect(within(container).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Round 1", "Round 2"]);
    expect(within(container).getByRole("tab", { name: "Round 2" }).getAttribute("aria-selected")).toBe("true");
    // Round 2 of the vote run: the tally is there.
    expect(within(container).getByRole("table")).toBeTruthy();
  });

  it("shows the proposals of the chosen round side by side, labelled Proposal A, B, C", () => {
    const { container } = renderFixture();
    roundTab(container, 1);
    const proposals = within(container).getByRole("list", { name: "Proposals, round 1" });
    expect(within(proposals).getAllByRole("region").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Proposal A",
      "Proposal B",
      "Proposal C",
    ]);
  });

  it("switches rounds with the arrow keys, moving focus with the selection", () => {
    const { container } = renderFixture();
    const tablist = within(container).getByRole("tablist", { name: "Rounds" });
    // The view opens on Round 2; ArrowLeft goes to Round 1 and moves focus there.
    const round1 = within(container).getByRole("tab", { name: "Round 1" });
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(round1.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(round1);
    fireEvent.keyDown(tablist, { key: "End" });
    expect(within(container).getByRole("tab", { name: "Round 2" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders critiques under their proposal with evidence citations as chips", () => {
    const { container } = renderFixture();
    selectDebateRun(container);
    roundTab(container, 1);
    const card = within(container).getByRole("region", { name: "Proposal A" });
    expect(within(card).getByText("Chunking misses the last partial line.")).toBeTruthy();
    const evidence = within(card).getByRole("list", { name: "Evidence" });
    expect(within(evidence).getAllByRole("listitem").map((c) => c.textContent)).toEqual(["src/average.ts:12", "spec §3.2"]);
    expect(within(card).getByText("Opus#2", { exact: false })).toBeTruthy();
    // Proposal B has no critique thread.
    expect(within(within(container).getByRole("region", { name: "Proposal B" })).queryByRole("list", { name: /Critiques of/ })).toBeNull();
  });

  it("renders proposal text as text, never as HTML", () => {
    const { container } = renderFixture();
    selectDebateRun(container);
    roundTab(container, 1);
    const card = within(container).getByRole("region", { name: "Proposal A" });
    expect(card.querySelector("b")).toBeNull();
    expect(within(card).getByText("Stream the file in chunks. <b>Bold</b> is text.")).toBeTruthy();
  });
});

describe("NegotiationView: reveal authors", () => {
  it("is off by default and is a switch that turns on", () => {
    const { container, queryByText, getAllByText } = renderFixture();
    roundTab(container, 1);
    const toggle = switchButton(container);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(queryByText(/^Author/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The fixture's proposal events carry no author, so the view says so instead of inventing one.
    expect(getAllByText("Author not in the event stream")).toHaveLength(3);
  });

  it("shows the seat's name when the proposal event does carry the author", () => {
    const events: EngineEvent[] = [
      { seq: 1, sessionId: "auth", at: "2026-10-25T11:00:00.000Z", type: "seat.spawned", seatId: "seat-a", data: { displayName: "Opus#1", provider: "mock", transport: "api", model: "AUTO", role: "proposer", permissions: "read-only" } } as EngineEvent,
      { seq: 2, sessionId: "auth", at: "2026-10-25T11:00:01.000Z", type: "stage.started", stageId: "p", data: { kind: "negotiate", strategy: "vote", attempt: 1 } } as EngineEvent,
      { seq: 3, sessionId: "auth", at: "2026-10-25T11:00:02.000Z", type: "negotiation.proposal", stageId: "p", seatId: "seat-a", data: { round: 1, label: "Proposal A", text: "Sum." } } as EngineEvent,
    ];
    const { container, store, getByText } = renderWithStore(<NegotiationView />);
    act(() => {
      store.getState().select("auth");
      store.getState().applyEvents("auth", events);
    });
    fireEvent.click(switchButton(container));
    expect(getByText("Author: Opus#1")).toBeTruthy();
  });
});

describe("NegotiationView: vote tally, consensus and decision", () => {
  it("shows each seat's ranking and the Borda totals", () => {
    const { container } = renderFixture();
    const table = within(container).getByRole("table");
    const points = within(table).getByRole("row", { name: /Borda points/ });
    expect(within(points).getAllByRole("cell").map((c) => c.textContent)).toEqual(["3", "5", "1"]);
    // Opus#1 ranked B, A, C: B is first (1), A second (2), C third (3).
    const seatRow = within(table).getByRole("row", { name: /Opus#1/ });
    expect(within(seatRow).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "1", "3"]);
  });

  it("the consensus meter's value is the score in the event", () => {
    const { container } = renderFixture();
    selectDebateRun(container);
    roundTab(container, 2);
    const meter = container.querySelector("meter") as HTMLMeterElement;
    expect(meter.value).toBe(0.8);
    expect(meter.getAttribute("aria-valuetext")).toBe("80%");
    expect(within(container).getByText("80%")).toBeTruthy();
    expect(within(container).getByText("Consensus reached")).toBeTruthy();

    roundTab(container, 1);
    expect((container.querySelector("meter") as HTMLMeterElement).value).toBe(0.4);
    expect(within(container).getByText("No consensus")).toBeTruthy();
  });

  it("the vote run's meter matches its event", () => {
    const { container } = renderFixture();
    expect((container.querySelector("meter") as HTMLMeterElement).value).toBe(5 / 6);
  });

  it("shows the decision with the preferred proposal's text", () => {
    const { container } = renderFixture();
    selectDebateRun(container);
    const card = within(container).getByRole("region", { name: "Decision" });
    expect(within(card).getByText("Consensus reached · preferred Proposal A")).toBeTruthy();
    expect(within(card).getByText("Stream in chunks and carry the partial line.")).toBeTruthy();
  });

  it("lists dissent with a flag, and says what the stream does not carry", () => {
    const { container } = renderFixture();
    selectDebateRun(container);
    const card = within(container).getByRole("region", { name: "Decision" });
    const dissent = within(card).getByRole("list");
    expect(dissent.textContent).toContain("⚑");
    expect(within(dissent).getByText("Sonnet#1", { exact: false })).toBeTruthy();
    expect(dissent.textContent).toContain("invalid negotiate-propose reply: no JSON found");
    expect(within(card).getByText(/Not in the event stream: the rationale, the consensus threshold/)).toBeTruthy();
  });
});

describe("NegotiationView: run labels and no-consensus runs", () => {
  it("names each run in the picker with its strategy, stage and attempt", () => {
    const { container } = renderFixture();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "1. debate (debate-1) · attempt 1",
      "2. vote (vote-1) · attempt 1",
    ]);
  });

  it("titles a run without consensus as a leading proposal, not a decision", () => {
    const events: EngineEvent[] = [
      { seq: 1, sessionId: "nc", at: "2026-10-25T11:00:00.000Z", type: "stage.started", stageId: "d", data: { kind: "negotiate", strategy: "debate", attempt: 1 } } as EngineEvent,
      { seq: 2, sessionId: "nc", at: "2026-10-25T11:00:01.000Z", type: "negotiation.proposal", stageId: "d", data: { round: 1, label: "Proposal A", text: "Only option." } } as EngineEvent,
      { seq: 3, sessionId: "nc", at: "2026-10-25T11:00:02.000Z", type: "negotiation.consensus", stageId: "d", data: { round: 1, score: 0.3, reached: false, preferred: "Proposal A" } } as EngineEvent,
    ];
    const { container, store, getByRole, queryByRole } = renderWithStore(<NegotiationView />);
    act(() => {
      store.getState().select("nc");
      store.getState().applyEvents("nc", events);
    });
    expect(queryByRole("region", { name: "Decision" })).toBeNull();
    const card = getByRole("region", { name: "Leading proposal (final decision not in the event stream)" });
    expect(within(card).getByRole("heading", { level: 3, name: "Leading proposal (final decision not in the event stream)" })).toBeTruthy();
    expect(within(card).getByText("No consensus · preferred Proposal A")).toBeTruthy();
    expect(container.querySelector("select")).toBeNull();
  });
});

describe("NegotiationView: sessions without negotiation", () => {
  it("renders nothing, and the selector is false, for a run with no negotiation events", () => {
    const { container, store } = renderWithStore(<NegotiationView />);
    act(() => {
      store.getState().select(sessionFixture.id);
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    expect(container.innerHTML).toBe("");
    expect(selectHasNegotiation(store.getState())).toBe(false);
    expect(selectHasNegotiation(renderFixtureStore())).toBe(true);
  });
});

/** A store with the negotiation fixture applied, for the selector check. */
function renderFixtureStore() {
  const { store } = renderWithStore(<NegotiationView />);
  act(() => {
    store.getState().select(negotiationFixture.id);
    store.getState().applyEvents(negotiationFixture.id, negotiationFixture.events);
  });
  return store.getState();
}
