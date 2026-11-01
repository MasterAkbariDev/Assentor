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
      "write:stop",
      "write:cancel",
    ]);
  });

  it("lists the write actions disabled: the command is the label, the reason is the action", () => {
    const writes = buildPaletteItems({ sessions, recentIds: [], ...none }).filter((i) => i.group === "Action");
    expect(writes.map((i) => i.label)).toEqual(["/model <seat> <model>", "/pause", "/inject <seat> …", "/approve", "/stop <seat>", "/cancel"]);
    expect(writes.map((i) => i.detail)).toEqual(["Change a seat's model", "Pause the run", "Send a message to a seat", "Approve the pending approval", "Stop a seat", "Cancel the session"]);
    // Without a `reasonFor` (no write access known), the model, approve, stop and cancel actions say why; pause and inject have their own reasons.
    expect(writes.map((i) => i.action.kind)).toEqual(Array(6).fill("blocked"));
    expect(writes[0]!.action).toEqual({ kind: "blocked", reason: WRITE_REASON });
    expect(WRITE_REASON).toBe("needs write access (not in the watch-only preview)");
  });
});
