import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEngineEvent } from "#assentor/protocol/events.js";
import { negotiateReviewFixture } from "./fixtures.js";

const FILE = new URL("../../fixtures/session-negotiate-review.ndjson", import.meta.url);
const generated = negotiateReviewFixture.events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("session-negotiate-review.ndjson", () => {
  it("is the committed copy of the generated stream", () => {
    if (process.env.UPDATE_FIXTURES) writeFileSync(FILE, generated);
    expect(readFileSync(FILE, "utf8")).toBe(generated);
  });

  it("parses line by line as valid, strictly increasing engine events", () => {
    const events = readFileSync(FILE, "utf8").trim().split("\n").map((line) => parseEngineEvent(JSON.parse(line)));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.type))).toContain("negotiation.consensus");
    expect(new Set(events.map((e) => e.type))).toContain("review.verdict");
  });
});
