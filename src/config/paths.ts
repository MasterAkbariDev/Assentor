import os from "node:os";
import path from "node:path";

/** Directory that holds user-global Assentor data (`~/.assentor`). */
export function userAssentorDir(): string {
  return path.join(os.homedir(), ".assentor");
}

/**
 * Root path passed to KeyVault / AgentRegistry so files land in `~/.assentor/`.
 * (Those APIs join `<root>/.assentor/...`.)
 */
export function userAssentorProjectRoot(): string {
  return os.homedir();
}

export function userConfigPath(): string {
  return path.join(userAssentorDir(), "config.yaml");
}

export function userSecretsPath(): string {
  return path.join(userAssentorDir(), "secrets.json");
}

export function projectConfigPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".assentor", "config.yaml");
}

/** @deprecated Prefer projectConfigPath — kept for call-site compatibility. */
export function assentorConfigPath(projectPath: string): string {
  return projectConfigPath(projectPath);
}

export function isUserDataRoot(projectPath: string): boolean {
  return path.resolve(projectPath) === path.resolve(userAssentorProjectRoot());
}
