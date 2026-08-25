import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "./lifecycle.js";

export const ASSENTOR_REPO_SLUG = "MasterAkbariDev/Assentor";
export const ASSENTOR_PACKAGE_URL = `https://raw.githubusercontent.com/${ASSENTOR_REPO_SLUG}/main/package.json`;
export const ASSENTOR_API_PACKAGE_URL = `https://api.github.com/repos/${ASSENTOR_REPO_SLUG}/contents/package.json?ref=main`;
export const ASSENTOR_CHANGELOG_URL = `https://github.com/${ASSENTOR_REPO_SLUG}/blob/main/CHANGELOG.md`;

export type SemVerTuple = [number, number, number];

export function parseSemver(version: string): SemVerTuple {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0] ?? "0.0.0";
  const parts = cleaned.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `remote` is strictly newer than `local`. */
export function isRemoteNewer(remote: string, local: string): boolean {
  const a = parseSemver(remote);
  const b = parseSemver(local);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

export function getLocalVersionSync(): string {
  try {
    const pkgPath = path.join(resolvePackageRoot(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function readChangelog(maxChars = 8_000): Promise<string> {
  const changelogPath = path.join(resolvePackageRoot(), "CHANGELOG.md");
  const raw = await fs.readFile(changelogPath, "utf8");
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n…[truncated — see CHANGELOG.md]`;
}

export interface UpdateCheckResult {
  local: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  source: "network" | "cache" | "skipped" | "error";
  message: string;
  changelogUrl: string;
}

interface UpdateCacheFile {
  checkedAt: string;
  local: string;
  latest: string;
}

export function updateCheckCachePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".assentor", "update-check.json");
}

export async function clearUpdateCheckCache(): Promise<void> {
  try {
    await fs.unlink(updateCheckCachePath());
  } catch {
    // ignore missing
  }
}

/**
 * Decide whether a cached remote version is still trustworthy.
 * Invalidate when the installed version changed, or when the cache claims
 * "local ahead" (usually means GitHub caught up after a push).
 */
export function isUpdateCacheReusable(
  cached: UpdateCacheFile,
  local: string,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (!cached.checkedAt || !cached.latest || !cached.local) return false;
  const age = nowMs - Date.parse(cached.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false;
  if (cached.local !== local) return false;
  // Stale "ahead" snapshots: remote may have been updated since we last fetched.
  if (isRemoteNewer(local, cached.latest)) return false;
  return true;
}

async function readCache(): Promise<UpdateCacheFile | null> {
  try {
    const raw = await fs.readFile(updateCheckCachePath(), "utf8");
    return JSON.parse(raw) as UpdateCacheFile;
  } catch {
    return null;
  }
}

async function writeCache(data: UpdateCacheFile): Promise<void> {
  try {
    await fs.mkdir(path.dirname(updateCheckCachePath()), { recursive: true });
    await fs.writeFile(
      updateCheckCachePath(),
      `${JSON.stringify(data, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // best-effort cache
  }
}

function versionFromPackageJsonText(text: string): string {
  const pkg = JSON.parse(text) as { version?: string };
  if (!pkg.version) {
    throw new Error("Remote package.json missing version");
  }
  return pkg.version;
}

async function fetchText(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "assentor-update-check",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prefer GitHub Contents API (fresher than raw CDN), then raw.githubusercontent.com.
 * Avoid query-string cache busters on raw URLs — they can hit stale CDN edges.
 */
export async function fetchLatestVersion(timeoutMs: number): Promise<string> {
  const errors: string[] = [];

  try {
    const text = await fetchText(ASSENTOR_API_PACKAGE_URL, timeoutMs, {
      Accept: "application/vnd.github.raw+json",
    });
    return versionFromPackageJsonText(text);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const text = await fetchText(ASSENTOR_PACKAGE_URL, timeoutMs, {
      Accept: "application/json",
    });
    return versionFromPackageJsonText(text);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  throw new Error(errors.join(" | "));
}

/**
 * Compare the installed Assentor version against GitHub `main` package.json.
 * Results are cached under ~/.assentor/update-check.json (default 6h).
 */
export async function checkForUpdate(options: {
  force?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetchFn?: typeof fetchLatestVersion;
} = {}): Promise<UpdateCheckResult> {
  const local = getLocalVersionSync();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60 * 1000;
  const changelogUrl = ASSENTOR_CHANGELOG_URL;

  if (process.env.ASSENTOR_SKIP_UPDATE_CHECK === "1") {
    return {
      local,
      latest: null,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      source: "skipped",
      message: "Update check skipped (ASSENTOR_SKIP_UPDATE_CHECK=1)",
      changelogUrl,
    };
  }

  if (!options.force) {
    const cached = await readCache();
    if (cached && isUpdateCacheReusable(cached, local, cacheTtlMs)) {
      return finalizeResult(local, cached.latest, cached.checkedAt, "cache");
    }
  }

  try {
    const fetchLatest = options.fetchFn ?? fetchLatestVersion;
    const latest = await fetchLatest(timeoutMs);
    const checkedAt = new Date().toISOString();
    await writeCache({ checkedAt, local, latest });
    return finalizeResult(local, latest, checkedAt, "network");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const cached = await readCache();
    if (cached?.latest) {
      // Never claim "local ahead" from a failed refresh — that snapshot is usually stale.
      if (isRemoteNewer(local, cached.latest)) {
        return {
          local,
          latest: null,
          updateAvailable: false,
          checkedAt: new Date().toISOString(),
          source: "error",
          message: `Could not verify updates (v${local} installed). ${detail}`,
          changelogUrl,
        };
      }
      const fallback = finalizeResult(
        local,
        cached.latest,
        cached.checkedAt,
        "cache",
      );
      return {
        ...fallback,
        message: `${fallback.message} (using cache — ${detail})`,
      };
    }
    return {
      local,
      latest: null,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      source: "error",
      message: `Could not check for updates (${detail})`,
      changelogUrl,
    };
  }
}

function finalizeResult(
  local: string,
  latest: string,
  checkedAt: string,
  source: "network" | "cache",
): UpdateCheckResult {
  const updateAvailable = isRemoteNewer(latest, local);
  const localAhead = isRemoteNewer(local, latest);
  let message: string;
  if (updateAvailable) {
    message = `Update available: v${local} → v${latest}`;
  } else if (localAhead) {
    message = `Local v${local} is ahead of GitHub main (v${latest})`;
  } else {
    message = `Up to date (v${local})`;
  }
  return {
    local,
    latest,
    updateAvailable,
    checkedAt,
    source,
    message,
    changelogUrl: ASSENTOR_CHANGELOG_URL,
  };
}
