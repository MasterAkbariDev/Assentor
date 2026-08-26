import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkForUpdate,
  getLocalVersionSync,
  isRemoteNewer,
  isUpdateCacheReusable,
  parseSemver,
  updateCheckCachePath,
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

describe("update cache reuse", () => {
  const now = Date.parse("2026-08-25T16:00:00.000Z");
  const ttl = 6 * 60 * 60 * 1000;

  it("reuses fresh equal-version cache", () => {
    expect(
      isUpdateCacheReusable(
        {
          checkedAt: "2026-08-25T15:00:00.000Z",
          local: "0.2.0",
          latest: "0.2.0",
        },
        "0.2.0",
        ttl,
        now,
      ),
    ).toBe(true);
  });

  it("invalidates when cache says local is ahead of remote", () => {
    expect(
      isUpdateCacheReusable(
        {
          checkedAt: "2026-08-25T15:00:00.000Z",
          local: "0.2.0",
          latest: "0.1.0",
        },
        "0.2.0",
        ttl,
        now,
      ),
    ).toBe(false);
  });

  it("invalidates when installed version changed", () => {
    expect(
      isUpdateCacheReusable(
        {
          checkedAt: "2026-08-25T15:00:00.000Z",
          local: "0.1.0",
          latest: "0.1.0",
        },
        "0.2.0",
        ttl,
        now,
      ),
    ).toBe(false);
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

  it("refetches instead of trusting a stale ahead cache", async () => {
    const cachePath = updateCheckCachePath();
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({
        checkedAt: new Date().toISOString(),
        local: "0.2.1",
        latest: "0.2.0",
      })}\n`,
    );

    let fetches = 0;
    const installed = getLocalVersionSync();
    const result = await checkForUpdate({
      force: false,
      fetchFn: async () => {
        fetches += 1;
        // Match installed package.json so finalize says "Up to date"
        return installed;
      },
    });
    expect(fetches).toBe(1);
    expect(result.latest).toBe(installed);
    expect(result.updateAvailable).toBe(false);
    expect(result.message).toMatch(/Up to date/i);
  });

  it("does not claim local-ahead when refresh fails against a stale cache", async () => {
    const cachePath = updateCheckCachePath();
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({
        checkedAt: new Date().toISOString(),
        local: "0.2.1",
        latest: "0.2.0",
      })}\n`,
    );

    const result = await checkForUpdate({
      force: true,
      fetchFn: async () => {
        throw new Error("network down");
      },
    });
    expect(result.updateAvailable).toBe(false);
    expect(result.source).toBe("error");
    expect(result.message).not.toMatch(/ahead/i);
    expect(result.message).toMatch(/Could not verify/i);
  });
});
