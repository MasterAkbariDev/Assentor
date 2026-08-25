import { describe, expect, it } from "vitest";
import {
  isRemoteNewer,
  parseSemver,
  checkForUpdate,
} from "../../src/self/version.js";

describe("semver helpers", () => {
  it("parses versions", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.2.0")).toEqual([0, 2, 0]);
    expect(parseSemver("2.0.0-beta.1")).toEqual([2, 0, 0]);
  });

  it("detects newer remotes", () => {
    expect(isRemoteNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isRemoteNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isRemoteNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isRemoteNewer("1.0.0", "0.9.9")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("marks update available when remote is newer", async () => {
    const result = await checkForUpdate({
      force: true,
      fetchFn: async () => "99.0.0",
    });
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe("99.0.0");
    expect(result.source).toBe("network");
  });

  it("marks up to date when remote matches or is older", async () => {
    const result = await checkForUpdate({
      force: true,
      fetchFn: async () => "0.0.1",
    });
    expect(result.updateAvailable).toBe(false);
    expect(result.latest).toBe("0.0.1");
  });
});
