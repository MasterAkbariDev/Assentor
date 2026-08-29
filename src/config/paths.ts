import os from "node:os";
import path from "node:path";

function resolveBaseHome(): string {
  return (
    process.env.ASSENTOR_HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    os.homedir()
  );
}

/** Directory that holds user-global Assentor data (`~/.assentor`). */
export function userAssentorDir(): string {
  if (process.env.ASSENTOR_USER_DIR) {
    return path.resolve(process.env.ASSENTOR_USER_DIR);
  }
  return path.join(resolveBaseHome(), ".assentor");
}

/**
 * Root path passed to KeyVault / AgentRegistry so files land in `~/.assentor/`.
 * (Those APIs join `<root>/.assentor/...`.)
 */
export function userAssentorProjectRoot(): string {
  if (process.env.ASSENTOR_USER_DIR) {
    return path.dirname(path.resolve(process.env.ASSENTOR_USER_DIR));
  }
  return resolveBaseHome();
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
