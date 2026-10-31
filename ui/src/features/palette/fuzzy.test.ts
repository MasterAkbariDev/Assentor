import { describe, expect, it } from "vitest";
import { fuzzyScore, rankItems } from "./fuzzy.js";

describe("fuzzyScore", () => {
  it("matches letters in order, not necessarily next to each other", () => {
    expect(fuzzyScore("ab", "a big bag")).not.toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("rejects a query whose letters are missing or out of order", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
    expect(fuzzyScore("ba", "ab")).toBeNull();
  });

  it("ignores case and spaces in the query", () => {
    expect(fuzzyScore("SESS BOARD", "session board")).not.toBeNull();
  });
});

describe("rankItems", () => {
  it("puts a run of consecutive letters at a word start above scattered letters", () => {
    const ranked = rankItems([{ label: "stale session" }, { label: "session" }], "ses");
    expect(ranked.map((x) => x.label)).toEqual(["session", "stale session"]);
  });

  it("drops items that do not match and keeps the order of ties", () => {
    const items = [{ label: "Old run" }, { label: "Implement average()" }, { label: "Old run" }];
    expect(rankItems(items, "")).toEqual(items);
    expect(rankItems(items, "avg").map((x) => x.label)).toEqual(["Implement average()"]);
  });
});
