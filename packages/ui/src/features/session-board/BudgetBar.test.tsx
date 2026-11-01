// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { UsageReport } from "#assentor/protocol/rpc.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport } from "../../transport/mock.js";
import { SessionBoard } from "./SessionBoard.js";
import { liveRun } from "./boardTestUtil.js";

afterEach(cleanup);

const ID = "budget-run";
const totals = (tokensIn: number, costUsd: number) => ({ tokensIn, tokensOut: 0, cachedTokens: 0, costUsd, calls: 1 });

function report(used: number, limit: number, costUsd = 0, extra: UsageReport["warnings"] = []): UsageReport {
  return {
    sessionId: ID,
    total: totals(used, costUsd),
    bySeat: {},
    byStage: {},
    byModel: {},
    retries: 0,
    warnings: [{ budget: "session.tokens", threshold: 0.5, used, limit }, ...extra],
  };
}

function setup(result: UsageReport | Error) {
  const transport = mockTransport({ handlers: { "usage.get": () => (result instanceof Error ? Promise.reject(result) : result) } });
  const rendered = renderWithStore(<SessionBoard />, undefined, transport);
  act(() => {
    rendered.store.getState().select(ID);
    rendered.store.getState().applyEvents(ID, liveRun(ID));
  });
  return { ...rendered, transport };
}

describe("BudgetBar", () => {
  it("shows used / limit and stays calm under 80%", async () => {
    const { findByRole, container } = setup(report(600, 1000));
    const group = await findByRole("group", { name: "Budget" });
    expect(group.textContent).toContain("tokens: 600 / 1,000 (60%)");
    expect(container.querySelector(".budget-item")!.getAttribute("data-state")).toBe("ok");
    expect(container.querySelector("progress")!.getAttribute("value")).toBe("600");
  });

  it("turns to the warning colour at 80% and says so in text", async () => {
    const { findByRole, container } = setup(report(800, 1000));
    const group = await findByRole("group", { name: "Budget" });
    expect(container.querySelector(".budget-item")!.getAttribute("data-state")).toBe("warn");
    expect(group.textContent).toContain("(80%) · nearing the limit");
  });

  it("shows the cost when it is known, and nothing when there is no budget and no cost", async () => {
    const withCost = setup(report(100, 1000, 0.1234));
    expect((await withCost.findByRole("group", { name: "Budget" })).textContent).toContain("Cost: $0.1234");
    cleanup();

    const nothing = setup({ ...report(100, 1000), warnings: [] });
    await waitFor(() => expect(nothing.transport.calls.some((c) => c.method === "usage.get")).toBe(true));
    expect(nothing.queryByRole("group", { name: "Budget" })).toBeNull();
  });

  it("ignores a seat's own budget and a failed usage.get", async () => {
    const seatOnly = report(100, 1000, 0, []);
    seatOnly.warnings = [{ budget: "seat.tokens", threshold: 0.8, used: 900, limit: 1000, seatId: "executor" }];
    const a = setup(seatOnly);
    await waitFor(() => expect(a.transport.calls.some((c) => c.method === "usage.get")).toBe(true));
    expect(a.queryByRole("group", { name: "Budget" })).toBeNull();
    cleanup();

    const b = setup(new Error("boom"));
    await waitFor(() => expect(b.transport.calls.some((c) => c.method === "usage.get")).toBe(true));
    expect(b.queryByRole("group", { name: "Budget" })).toBeNull();
  });
});
