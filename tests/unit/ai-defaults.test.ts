import { describe, expect, it } from "vitest";
import { parseAssentorConfig } from "../../src/index.js";
import {
  buildAiRows,
  cycleAiField,
  cycleRunMode,
  EXECUTOR_OPTIONS,
} from "../../src/tui/screens/settings.js";

describe("AI defaults", () => {
  it("lists mode then every selectable executor", () => {
    const config = parseAssentorConfig({});
    const rows = buildAiRows(config, { installedIds: new Set(["antigravity"]) });
    expect(rows[0]).toMatch(/Supervised/);
    expect(rows[1]).toMatch(/Mock/);
    expect(EXECUTOR_OPTIONS).toContain("antigravity");
    expect(EXECUTOR_OPTIONS).toContain("claude-code");
    expect(EXECUTOR_OPTIONS).not.toContain("gemini-cli");
  });

  it("cycles mode then executor including installed CLIs", () => {
    let config = parseAssentorConfig({});
    config = cycleAiField(config, 0, 1, ["AUTO"]);
    expect(config.run.mode).toBe("autopilot");
    expect(cycleRunMode(config, -1).run.mode).toBe("supervised");

    config = parseAssentorConfig({ executor: { provider: "cursor" } });
    const next = cycleAiField(config, 1, 1, ["AUTO"]);
    expect(next.executor.provider).toBe("claude-code");
  });

  it("marks installed executors in the AI defaults row", () => {
    const config = parseAssentorConfig({
      executor: { provider: "antigravity" },
    });
    const rows = buildAiRows(config, {
      installedIds: new Set(["antigravity"]),
    });
    expect(rows[1]).toMatch(/Antigravity ✓/);
  });
});
