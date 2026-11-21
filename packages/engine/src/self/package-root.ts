import path from "node:path";
import { fileURLToPath } from "node:url";

let packagedRoot: string | undefined;

/** Set by the native executable before it loads configuration or built-ins. */
export function setPackagedRoot(directory: string): void {
  packagedRoot = path.resolve(directory);
}

/**
 * Resolve the Assentor package root (repo or ~/.assentor install), where
 * `package.json`, `prompts/`, `playbooks/` and the built UI live.
 */
export function resolvePackageRoot(): string {
  if (packagedRoot) return packagedRoot;
  const file = fileURLToPath(import.meta.url);
  // Built: <root>/dist/self/package-root.js. Source (tests): <root>/packages/engine/src/self/package-root.ts.
  return path.resolve(path.dirname(file), file.endsWith(".ts") ? "../../../.." : "../..");
}
