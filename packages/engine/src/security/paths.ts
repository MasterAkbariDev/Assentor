import path from "node:path";
import { promises as fs } from "node:fs";
import { AssentorError } from "../core/errors.js";
import { redactSecrets, type RedactionResult } from "./redact.js";

export class PathSecurityError extends AssentorError {
  constructor(message: string) {
    super("PATH_SECURITY", message);
    this.name = "PathSecurityError";
  }
}

/**
 * Resolves `requested` against `projectRoot` and rejects path traversal
 * or paths that escape the project.
 */
export function assertSafeProjectPath(
  projectRoot: string,
  requested: string,
): string {
  if (!requested || requested.trim().length === 0) {
    throw new PathSecurityError("Path must be non-empty");
  }

  if (path.isAbsolute(requested)) {
    throw new PathSecurityError(`Absolute paths are not allowed: ${requested}`);
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, requested);

  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PathSecurityError(
      `Path escapes project root: ${requested}`,
    );
  }

  return resolved;
}

/**
 * Like `assertSafeProjectPath`, but also resolves symlinks and rejects a path
 * whose real location is outside the project. The target must exist.
 * Returns the real path.
 */
export async function resolveContainedProjectPath(
  projectRoot: string,
  requested: string,
): Promise<string> {
  const absolute = assertSafeProjectPath(projectRoot, requested);
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(absolute),
  ]);
  const relative = path.relative(realRoot, realPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PathSecurityError(
      `Path resolves outside project root: ${requested}`,
    );
  }
  return realPath;
}

/**
 * Read a project text file for reviewer evidence: contained in the project
 * (symlinks included), a regular file no larger than `maxBytes`, with secrets
 * redacted. Returns undefined when the file is missing or unusable.
 */
export async function readGuardedProjectText(
  projectRoot: string,
  requested: string,
  maxBytes = 200_000,
): Promise<RedactionResult | undefined> {
  try {
    const realPath = await resolveContainedProjectPath(projectRoot, requested);
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size > maxBytes) {
      return undefined;
    }
    return redactSecrets(await fs.readFile(realPath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readProjectFile(absolutePath: string): Promise<string> {
  return fs.readFile(absolutePath, "utf8");
}

export async function listProjectDirectory(
  absolutePath: string,
): Promise<string[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  return entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}
