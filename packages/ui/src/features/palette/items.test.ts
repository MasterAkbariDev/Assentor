import { describe, expect, it } from "vitest";
import type { SessionSummary } from "#assentor/protocol/rpc.js";
import { buildPaletteItems, WRITE_REASON } from "./items.js";

const sessions: SessionSummary[] = [
  { id: "a", title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 3 },
  { id: "b", title: "Old run", hasLiveLog: false, lastSeq: 0 },
];

const none = { hasSeats: false, hasNegotiation: false, hasLeadBoard: false, hasReview: false };

describe("buildPaletteItems", () => {
  it("lists recent runs first, then the other runs, then the views on screen", () => {
    const items = buildPaletteItems({ sessions, recentIds: ["b", "gone"], ...none, hasSeats: true, hasLeadBoard: true, hasReview: true });
    expect(items.map((i) => i.id)).toEqual([
      "recent:b",
      "session:a",
      "view:.seat-board",
      "view:.lead-board",
      "view:.review",
      "write:model",
      "write:pause",
      "write:inject",
      "write:approve",
    ]);
  });

  it("lists the write actions disabled: the command is the label, the reason is the action", () => {
    const writes = buildPaletteItems({ sessions, recentIds: [], ...none }).filter((i) => i.group === "Action");
    expect(writes.map((i) => i.label)).toEqual(["/model <seat> <model>", "/pause", "/inject <seat> …", "/approve"]);
    expect(writes.map((i) => i.detail)).toEqual(["Change a seat's model", "Pause the run", "Send a message to a seat", "Approve the integration"]);
    for (const item of writes) {
      expect(item.action).toEqual({ kind: "blocked", reason: WRITE_REASON });
    }
    expect(WRITE_REASON).toBe("needs write access (not in the watch-only preview)");
  });
});
