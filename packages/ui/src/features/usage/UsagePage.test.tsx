// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import type { UsageReport } from "#assentor/protocol/rpc.js";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { UsagePage, USAGE_REFRESH_MS } from "./UsagePage.js";

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
function total(view: ReturnType<typeof setup>, label: string): string | null {
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

  it("says no budget has reached 50% when there are no warnings", async () => {
    const view = setup(REPORT);
    await view.findByText("No budget has reached 50%.");
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
    await new Promise((resolve) => setTimeout(resolve, USAGE_REFRESH_MS + 100));
    expect(loads).toBe(3);
  });
});
