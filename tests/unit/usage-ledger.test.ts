import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createId } from "../../packages/engine/src/core/ids.js";
import { sessionPaths } from "../../packages/engine/src/persistence/paths.js";
import { readSessionEvents } from "../../packages/engine/src/events/log.js";
import { UsageLedger, usageFromEvents } from "../../packages/engine/src/usage/ledger.js";
import { createEngineRpcServer } from "../../packages/engine/src/rpc/engine.js";
import { createInProcessTransport } from "../../packages/engine/src/rpc/transports.js";
import { RpcClient, RpcRemoteError } from "../../packages/protocol/src/rpc-client.js";
import { UsageReportSchema } from "../../packages/protocol/src/rpc.js";
import { formatUsage, formatUsageLine, usageCommand } from "../../packages/cli/src/cli/usage.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A fixture event log on disk; the second build turn is an old-format line without `cachedTokens`. */
async function fixture(): Promise<{ projectPath: string; sessionId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "usage-"));
  dirs.push(projectPath);
  const sessionId = createId();
  let seq = 0;
  const line = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ seq: ++seq, sessionId, at: "2026-10-31T10:00:00.000Z", type, data, ...extra });
  const spawned = (seatId: string, provider: string, model: string) =>
    line(
      "seat.spawned",
      { displayName: seatId, provider, transport: "api", model, role: "builder", permissions: "edit" },
      { seatId },
    );
  const lines = [
    line("session.created", { title: "fixture" }),
    spawned("builder", "anthropic", "sonnet"),
    spawned("reviewer-1", "openai", "gpt-4o-mini"),
    line("seat.tokens", { tokensIn: 1000, tokensOut: 200, cachedTokens: 600, costUsd: 0.01 }, { seatId: "builder", stageId: "build" }),
    line("seat.tokens", { tokensIn: 1500, tokensOut: 300 }, { seatId: "builder", stageId: "build" }),
    line("seat.retry", { attempt: 2, maxAttempts: 3, delayMs: 10 }, { seatId: "reviewer-1" }),
    line("seat.tokens", { tokensIn: 800, tokensOut: 100, cachedTokens: 0 }, { seatId: "reviewer-1", stageId: "review" }),
    line("seat.model.changed", { from: "sonnet", to: "opus", pending: false }, { seatId: "builder" }),
    line("seat.tokens", { tokensIn: 50, tokensOut: 5 }, { seatId: "builder" }),
    line("session.warning", { kind: "budget", budget: "session.tokens", threshold: 0.5, used: 3955, limit: 6000, message: "…" }),
    line("session.warning", { kind: "pair-navigator", message: "not a budget" }),
  ];
  const file = sessionPaths(projectPath, sessionId).events;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  return { projectPath, sessionId };
}

describe("UsageLedger", () => {
  it("totals equal the sum of seat.tokens, by seat, stage and model; old lines without cachedTokens work", async () => {
    const { projectPath, sessionId } = await fixture();
    const events = await readSessionEvents(projectPath, sessionId);
    const report = usageFromEvents(events, sessionId, {
      "openai/gpt-4o-mini": { inPerMTok: 1, outPerMTok: 2 },
    });

    const tokens = events.flatMap((e) => (e.type === "seat.tokens" ? [e.data] : []));
    expect(report.total).toEqual({
      tokensIn: tokens.reduce((sum, t) => sum + t.tokensIn, 0),
      tokensOut: tokens.reduce((sum, t) => sum + t.tokensOut, 0),
      cachedTokens: 600,
      // reported $0.01, plus the reviewer priced from the table: (800 × 1 + 100 × 2) / 1M.
      costUsd: 0.01 + 0.001,
      calls: 4,
    });
    expect(report.bySeat.builder).toMatchObject({ tokensIn: 2550, tokensOut: 505, calls: 3 });
    expect(report.byStage).toMatchObject({
      build: { tokensIn: 2500, calls: 2 },
      review: { tokensIn: 800, calls: 1 },
      "-": { tokensIn: 50, calls: 1 },
    });
    expect(Object.keys(report.byModel)).toEqual(["anthropic/sonnet", "openai/gpt-4o-mini", "anthropic/opus"]);
    expect(report.retries).toBe(1);
    expect(report.warnings).toEqual([{ budget: "session.tokens", threshold: 0.5, used: 3955, limit: 6000 }]);
    expect(UsageReportSchema.parse(report)).toEqual(report);
  });

  it("folds incrementally and snapshots are copies", () => {
    const ledger = new UsageLedger("s");
    ledger.add({ seq: 1, sessionId: "s", at: "", type: "seat.tokens", seatId: "a", data: { tokensIn: 5, tokensOut: 1 } });
    const first = ledger.snapshot();
    ledger.add({ seq: 2, sessionId: "s", at: "", type: "seat.tokens", seatId: "a", data: { tokensIn: 5, tokensOut: 1 } });
    expect(first.total.tokensIn).toBe(5);
    expect(ledger.snapshot().total).toEqual({ tokensIn: 10, tokensOut: 2, cachedTokens: 0, costUsd: 0, calls: 2 });
  });
});

describe("usage report output", () => {
  it("prints one line when nothing was reported, a table otherwise", async () => {
    expect(formatUsage(usageFromEvents([]))).toEqual(["Usage: no token counts reported by these seats"]);
    const { projectPath, sessionId } = await fixture();
    const report = usageFromEvents(await readSessionEvents(projectPath, sessionId));
    expect(formatUsageLine(report)).toBe("Usage: 3,955 tokens · in 3,350 (cached 600) · out 605 · 4 calls · 1 retry · $0.0100");
    expect(formatUsage(report, { concise: true })).toHaveLength(1);
    const table = formatUsage(report);
    expect(table.some((l) => l.includes("seat builder") && l.includes("2,550"))).toBe(true);
    expect(table.some((l) => l.includes("stage review"))).toBe(true);
    expect(table.at(-1)).toBe("  budget session.tokens passed 50%: 3955 of 6000");
  });

  it("`usage --json` prints a schema-valid report; the default is the latest session", async () => {
    const { projectPath, sessionId } = await fixture();
    const out: string[] = [];
    const err: string[] = [];
    expect(await usageCommand({ projectPath, json: true, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(0);
    const report = UsageReportSchema.parse(JSON.parse(out.join("\n")));
    expect(report.sessionId).toBe(sessionId);
    expect(report.total.calls).toBe(4);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "usage-empty-"));
    dirs.push(empty);
    expect(await usageCommand({ projectPath: empty, out: () => {}, err: (l) => err.push(l) })).toBe(1);
    expect(err.at(-1)).toMatch(/No sessions with an event log/);
  });
});

describe("usage.get RPC", () => {
  it("returns the ledger of a session and rejects a bad id", async () => {
    const { projectPath, sessionId } = await fixture();
    const server = createEngineRpcServer({ projectPath, engineVersion: "test" });
    const client = new RpcClient(createInProcessTransport(server).client);
    try {
      const report = await client.call("usage.get", { sessionId });
      expect(report.total.tokensIn).toBe(3350);
      expect(report.bySeat["reviewer-1"]?.calls).toBe(1);
      expect((await client.call("usage.get", { sessionId: createId() })).total.calls).toBe(0);
      await expect(client.call("usage.get", { sessionId: "../etc" })).rejects.toBeInstanceOf(RpcRemoteError);
    } finally {
      client.close();
    }
  });
});
