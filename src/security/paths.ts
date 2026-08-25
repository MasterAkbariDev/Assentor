import path from "node:path";
import { promises as fs } from "node:fs";
import { AssentorError } from "../core/errors.js";

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
