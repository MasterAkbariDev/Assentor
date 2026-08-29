import { describe, expect, it } from "vitest";
import { runPreflight } from "../../src/cli/preflight.js";

describe("runPreflight", () => {
  it("does not spawn a live Cursor PONG probe by default", async () => {
    const started = Date.now();
    const result = await runPreflight({
      executor: "cursor",
      reviewers: [{ provider: "mock" }],
      projectPath: process.cwd(),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    const cursor = result.checks.find((check) => check.name === "executor:cursor");
    expect(cursor).toBeDefined();
    expect(cursor?.detail).not.toMatch(/PONG|probe timed out/i);
  });

  it("still runs a live probe when doctor asks for it", async () => {
    const result = await runPreflight({
      executor: "mock",
      reviewers: [{ provider: "mock" }],
      projectPath: process.cwd(),
      probeCursor: true,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.some((c) => c.name === "executor:mock")).toBe(true);
  });

  it("probes a registered print CLI without spawning it", async () => {
    const result = await runPreflight({
      executor: "antigravity",
      reviewers: [{ provider: "mock" }],
      projectPath: process.cwd(),
    });
    const check = result.checks.find((c) => c.name === "executor:antigravity");
    expect(check).toBeDefined();
    expect(check?.detail).not.toMatch(/PONG|probe timed out/i);
  });
});
