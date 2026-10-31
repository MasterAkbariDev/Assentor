import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@engine/protocol/rpc.js";
import { buildPaletteItems, WRITE_REASON } from "./items.js";

const sessions: SessionSummary[] = [
  { id: "a", title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 3 },
  { id: "b", title: "Old run", hasLiveLog: false, lastSeq: 0 },
];

const none = { hasSeats: false, hasNegotiation: false, hasLeadBoard: false };

describe("buildPaletteItems", () => {
  it("lists recent runs first, then every run, and only the views that are on screen", () => {
    const items = buildPaletteItems({ sessions, recentIds: ["b", "gone"], ...none, hasSeats: true, hasLeadBoard: true });
    expect(items.map((i) => i.id)).toEqual([
      "recent:b",
      "session:a",
      "session:b",
      "view:.seat-board",
      "view:.lead-board",
      "write:model",
      "write:pause",
      "write:inject",
      "write:approve",
    ]);
  });

  it("lists the write actions disabled, with the reason, and never as runnable sessions", () => {
    const writes = buildPaletteItems({ sessions, recentIds: [], ...none }).filter((i) => i.group === "Action");
    expect(writes).toHaveLength(4);
    for (const item of writes) {
      expect(item.action).toEqual({ kind: "blocked", reason: WRITE_REASON });
      expect(item.detail).toBe(WRITE_REASON);
    }
    expect(WRITE_REASON).toBe("needs write access (not in the watch-only preview)");
  });
});
