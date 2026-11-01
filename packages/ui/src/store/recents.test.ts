// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngineStore, RECENT_LIMIT } from "./engineStore.js";
import { loadRecents } from "./recents.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("recent runs", () => {
  it("keeps the last 20 selected runs, newest first, and saves them", () => {
    expect(RECENT_LIMIT).toBe(20);
    const store = createEngineStore();
    for (let i = 0; i < 25; i += 1) store.getState().select(`run-${i}`);
    store.getState().select("run-10");
    const ids = store.getState().recentIds;
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 2)).toEqual(["run-10", "run-24"]);
    expect(JSON.parse(localStorage.getItem("assentor.recentSessions")!)).toEqual(ids);
    expect(createEngineStore().getState().recentIds).toEqual(ids);
  });

  it("starts empty when the saved value is corrupt, not a list, or storage throws", () => {
    localStorage.setItem("assentor.recentSessions", "{not json");
    expect(loadRecents(20)).toEqual([]);
    localStorage.setItem("assentor.recentSessions", JSON.stringify({ a: 1 }));
    expect(loadRecents(20)).toEqual([]);
    localStorage.setItem("assentor.recentSessions", JSON.stringify(["a", 3, "b"]));
    expect(loadRecents(20)).toEqual(["a", "b"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const store = createEngineStore();
    expect(store.getState().recentIds).toEqual([]);
    expect(() => store.getState().select("x")).not.toThrow();
    expect(store.getState().recentIds).toEqual(["x"]);
  });
});
