import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the Assentor package root (repo or ~/.assentor install), where
 * `package.json`, `prompts/`, `playbooks/` and the built UI live.
 */
export function resolvePackageRoot(): string {
  const file = fileURLToPath(import.meta.url);
  // Built: <root>/dist/self/package-root.js. Source (tests): <root>/packages/engine/src/self/package-root.ts.
  return path.resolve(path.dirname(file), file.endsWith(".ts") ? "../../../.." : "../..");
}
