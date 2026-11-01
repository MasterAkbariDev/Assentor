// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import type { UsageReport } from "#assentor/protocol/rpc.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { UsagePage } from "./UsagePage.js";

afterEach(() => cleanup());

const SESSION = sessionFixture.id;
const TOTAL = { tokensIn: 12000, tokensOut: 3000, cachedTokens: 3000, costUsd: 0.4321, calls: 6 };
const EXECUTOR = { tokensIn: 9000, tokensOut: 2000, cachedTokens: 3000, costUsd: 0.3, calls: 4 };
const REVIEWER = { tokensIn: 3000, tokensOut: 1000, cachedTokens: 0, costUsd: 0.1321, calls: 2 };

/** A report whose seats and stages add up to its total. */
const REPORT: UsageReport = {
  sessionId: SESSION,
  total: TOTAL,
  bySeat: { executor: EXECUTOR, "reviewer-1": REVIEWER },
  byStage: { build: TOTAL },
  byModel: { "mock/AUTO": TOTAL },
  retries: 1,
  warnings: [],
};

const NO_TOKENS: UsageReport = { sessionId: SESSION, total: { tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: 0, calls: 0 }, bySeat: {}, byStage: {}, byModel: {}, retries: 0, warnings: [] };

function setup(report: UsageReport, extra: { warnings?: UsageReport["warnings"] } = {}) {
  const transport = mockTransport({ handlers: { "usage.get": () => ({ ...report, warnings: extra.warnings ?? report.warnings }) } });
  const store = createEngineStore();
  store.getState().select(SESSION);
  act(() => {
    store.getState().applyEvents(SESSION, sessionFixture.events);
  });
  const view = renderWithStore(<UsagePage />, store, transport);
  return { ...view, store, transport };
}

/** The value next to a totals label (`<dt>` then `<dd>`). */
function total(view: { container: HTMLElement }, label: string): string | null {
  const term = within(view.container.querySelector(".usage-totals") as HTMLElement).getByText(label);
  return term.nextElementSibling?.textContent ?? null;
}

describe("UsagePage", () => {
  it("shows totals that match the fixture report, and the tables add up to them", async () => {
    const view = setup(REPORT);
    await view.findByRole("table", { name: "By seat" });
    expect(total(view, "Tokens in")).toBe("12,000");
    expect(total(view, "Tokens out")).toBe("3,000");
    expect(total(view, "Cached share")).toBe("25%");
    expect(total(view, "Cost")).toBe("$0.4321");
    expect(total(view, "Model calls")).toBe("6");
    expect(total(view, "Retries")).toBe("1");

    const seats = within(view.getByRole("table", { name: "By seat" }));
    expect(seats.getByRole("rowheader", { name: "Executor" }).closest("tr")!.textContent).toContain("9,000");
    expect(seats.getByRole("rowheader", { name: "Opus#1" }).closest("tr")!.textContent).toContain("3,000");
    const stage = within(view.getByRole("table", { name: "By stage" }));
    expect(stage.getByRole("rowheader", { name: "build" }).closest("tr")!.textContent).toContain("12,000");
    expect(within(view.getByRole("table", { name: "By model" })).getByRole("rowheader", { name: "mock/AUTO" })).toBeTruthy();

    expect(REPORT.bySeat.executor!.tokensIn + REPORT.bySeat["reviewer-1"]!.tokensIn).toBe(REPORT.total.tokensIn);
  });

  it("shows the empty state when no token counts were reported", async () => {
    const view = setup(NO_TOKENS);
    await view.findByText("No token counts reported for this run yet.");
    expect(view.queryByRole("table")).toBeNull();
  });

  it("shows a budget bar in the state its last warning reached", async () => {
    const warnings: UsageReport["warnings"] = [
      { budget: "session.tokens", threshold: 0.5, used: 5200, limit: 10000 },
      { budget: "session.tokens", threshold: 0.8, used: 8100, limit: 10000 },
    ];
    const view = setup({ ...REPORT, total: { ...TOTAL, tokensIn: 7000, tokensOut: 1500 } }, { warnings });
    const bar = await view.findByText(/session tokens: 8,500 of 10,000/);
    expect(bar.textContent).toContain("(85%), past the 80% warning");
    expect(bar.closest(".usage-budget")!.getAttribute("data-state")).toBe("warn80");
  });

  it("shows a cost under one cent as <$0.01", async () => {
    const view = setup({ ...REPORT, total: { ...TOTAL, costUsd: 0.004 } });
    await view.findByRole("table", { name: "By seat" });
    expect(total(view, "Cost")).toBe("<$0.01");
  });

  it("says no budget has reached 50% when there are no warnings", async () => {
    const view = setup(REPORT);
    await view.findByText("No budget has reached 50%.");
  });

  it("never has two usage.get calls in flight, and applies every result", async () => {
    const resolvers: Array<(r: UsageReport) => void> = [];
    const report = (tokensIn: number): UsageReport => ({ ...REPORT, total: { ...TOTAL, tokensIn }, bySeat: {}, byStage: {}, byModel: {} });
    const transport = mockTransport({ handlers: { "usage.get": () => new Promise<UsageReport>((resolve) => resolvers.push(resolve)) } });
    const store = createEngineStore();
    store.getState().select(SESSION);
    const view = renderWithStore(<UsagePage />, store, transport);
    await waitFor(() => expect(resolvers.length).toBe(1));

    // Events keep arriving while the first call is still out: none may start another call.
    const tokens = (seq: number): EngineEvent =>
      ({ type: "seat.tokens", sessionId: SESSION, seatId: "executor", seq, at: new Date(0).toISOString(), data: { tokensIn: 100, tokensOut: 10 } }) as never;
    for (let seq = 1; seq <= 5; seq += 1) act(() => store.getState().applyEvents(SESSION, [tokens(seq)]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolvers.length).toBe(1);

    // The first result is shown, not dropped; one follow-up call covers all the events that came meanwhile.
    act(() => resolvers[0]!(report(1111)));
    await waitFor(() => expect(resolvers.length).toBe(2));
    expect(total(view, "Tokens in")).toBe("1,111");
    act(() => resolvers[1]!(report(2222)));
    await waitFor(() => expect(total(view, "Tokens in")).toBe("2,222"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolvers.length).toBe(2);
  });

  it("reloads the report when seat.tokens events arrive, once per burst", async () => {
    let loads = 0;
    const transport = mockTransport({
      handlers: {
        "usage.get": () => {
          loads += 1;
          return REPORT;
        },
      },
    });
    const store = createEngineStore();
    store.getState().select(SESSION);
    renderWithStore(<UsagePage />, store, transport);
    await waitFor(() => expect(loads).toBe(1));

    const tokens = (seq: number): EngineEvent =>
      ({ type: "seat.tokens", sessionId: SESSION, seatId: "executor", seq, at: new Date(0).toISOString(), data: { tokensIn: 100, tokensOut: 10 } }) as never;
    act(() => store.getState().applyEvents(SESSION, [tokens(1), tokens(2), tokens(3)]));
    await waitFor(() => expect(loads).toBe(2));

    act(() => {
      store.getState().applyEvents(SESSION, [tokens(4)]);
      store.getState().applyEvents(SESSION, [tokens(5)]);
    });
    await waitFor(() => expect(loads).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loads).toBe(3);
  });

  it("shows skills loaded with totals that match the fixture, and estimate vs actual", async () => {
    const skills = {
      tdd: { loads: 3, tokens: 880, seats: ["executor", "reviewer-1"] },
      docs: { loads: 1, tokens: 50, seats: ["executor"] },
    };
    const view = setup({ ...REPORT, skills, estimate: { tokens: { low: 10000, high: 14000 }, usd: { low: 0.1, high: 0.2 } } });
    await view.findByRole("table", { name: "By seat" });
    const table = within(view.container.querySelector(".usage-skills table") as HTMLElement);
    const tdd = table.getByRole("rowheader", { name: "tdd" }).closest("tr")!;
    expect(tdd.textContent).toBe("tddExecutor, Opus#1" + "3" + "880");
    // Column sums match the fixture.
    const sum = (col: number) => [...view.container.querySelectorAll(".usage-skills tbody tr")].reduce((n, tr) => n + Number(tr.children[col]!.textContent!.replace(/,/g, "")), 0);
    expect(sum(2)).toBe(4);
    expect(sum(3)).toBe(930);

    const est = within(view.container.querySelector(".usage-estimate") as HTMLElement);
    const tokens = est.getByRole("rowheader", { name: "Tokens" }).closest("tr")!;
    expect(tokens.textContent).toBe("Tokens10,000–14,00015,0001,000 over the high end");
    const cost = est.getByRole("rowheader", { name: "Cost" }).closest("tr")!;
    expect(cost.textContent).toBe("Cost$0.10–$0.20$0.4321$0.2321 over the high end");
  });

  it("shows empty states for skills and estimate, and unknown when the estimate has no price", async () => {
    const view = setup(REPORT);
    await view.findByText("No skills were loaded in this run.");
    view.getByText("This run logged no pre-run estimate.");
    cleanup();
    const partial = setup({ ...REPORT, unpricedCalls: 2, skills: { x: { loads: 1, tokens: 5, seats: ["-"] } }, estimate: { tokens: { low: 1, high: 2 }, usd: { low: 0.1, high: 0.2 } } });
    const row = (await partial.findByRole("rowheader", { name: "Cost" })).closest("tr")!;
    expect(row.textContent).toBe("Cost$0.10–$0.20≥ $0.4321 (some calls unpriced)unknown (actual is partial)");
    expect(partial.container.querySelector(".usage-skills tbody tr")!.textContent).toBe("x(no seat)15");
    expect(partial.container.querySelectorAll(".usage-table-wrap caption").length).toBeGreaterThanOrEqual(2);
    cleanup();
    const unpriced = setup({ ...REPORT, estimate: { tokens: { low: 15000, high: 15000 } } });
    const cost = (await unpriced.findByRole("rowheader", { name: "Cost" })).closest("tr")!;
    expect(cost.textContent).toBe("Costunknownunknownunknown");
    expect(unpriced.container.querySelector(".usage-estimate tbody tr")!.textContent).toBe("Tokens15,00015,000within the estimate");
  });
});
