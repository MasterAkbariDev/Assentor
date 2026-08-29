import { promises as fs } from "node:fs";
import path from "node:path";

export type VerificationSlot = "typecheck" | "test" | "lint" | "build";

export interface VerificationCommands {
  typecheck: string;
  test: string;
  lint: string;
  build: string;
}

export interface DetectedProjectCommands extends VerificationCommands {
  packageManager?: string;
  projectType?: string;
}

const EMPTY_COMMANDS: VerificationCommands = {
  typecheck: "",
  test: "",
  lint: "",
  build: "",
};

export function emptyVerificationCommands(): VerificationCommands {
  return { ...EMPTY_COMMANDS };
}

export function hasAnyCommand(commands: VerificationCommands): boolean {
  return Boolean(
    commands.typecheck || commands.test || commands.lint || commands.build,
  );
}

export function commandForSlot(
  commands: VerificationCommands,
  slot: VerificationSlot,
): string | undefined {
  const value = commands[slot]?.trim();
  return value ? value : undefined;
}

/**
 * Detect test/lint/typecheck/build commands from lockfiles and manifests.
 * Empty string means "no command for this slot" — never invent npm scripts
 * for a Cargo/Go/Python-only repo.
 */
export async function detectVerificationCommands(
  projectPath: string,
): Promise<DetectedProjectCommands> {
  const root = path.resolve(projectPath);
  const detected: DetectedProjectCommands = { ...EMPTY_COMMANDS };

  const node = await detectNode(root);
  if (node) {
    Object.assign(detected, node);
  }

  if (!hasAnyCommand(detected)) {
    const rust = await detectRust(root);
    if (rust) Object.assign(detected, rust);
  }

  if (!hasAnyCommand(detected)) {
    const go = await detectGo(root);
    if (go) Object.assign(detected, go);
  }

  if (!hasAnyCommand(detected)) {
    const python = await detectPython(root);
    if (python) Object.assign(detected, python);
  }

  return detected;
}

/**
 * Fill empty slots from detection; configured non-empty strings win.
 */
export async function resolveVerificationCommands(
  projectPath: string,
  configured?: Partial<VerificationCommands>,
): Promise<VerificationCommands> {
  const detected = await detectVerificationCommands(projectPath);
  return {
    typecheck: configured?.typecheck?.trim() || detected.typecheck,
    test: configured?.test?.trim() || detected.test,
    lint: configured?.lint?.trim() || detected.lint,
    build: configured?.build?.trim() || detected.build,
  };
}

async function detectNode(
  root: string,
): Promise<DetectedProjectCommands | undefined> {
  const pkgPath = path.join(root, "package.json");
  if (!(await fileExists(pkgPath))) {
    return undefined;
  }

  let scripts: Record<string, string> = {};
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return undefined;
  }

  const pm = await detectPackageManager(root);
  const commands: DetectedProjectCommands = {
    ...EMPTY_COMMANDS,
    packageManager: pm,
    projectType: "node",
  };

  if (scripts.test) {
    commands.test = scriptCommand(pm, "test");
  }
  if (scripts.typecheck) {
    commands.typecheck = scriptCommand(pm, "typecheck");
  } else if (await fileExists(path.join(root, "tsconfig.json"))) {
    commands.typecheck = "npx tsc --noEmit";
  }
  if (scripts.lint) {
    commands.lint = scriptCommand(pm, "lint");
  }
  if (scripts.build) {
    commands.build = scriptCommand(pm, "build");
  }

  return commands;
}

async function detectPackageManager(
  root: string,
): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  const locks: Array<[string, "pnpm" | "yarn" | "bun" | "npm"]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of locks) {
    if (await fileExists(path.join(root, file))) {
      return pm;
    }
  }
  return "npm";
}

function scriptCommand(pm: string, script: string): string {
  if (pm === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  return `${pm} run ${script}`;
}

async function detectRust(
  root: string,
): Promise<DetectedProjectCommands | undefined> {
  if (!(await fileExists(path.join(root, "Cargo.toml")))) {
    return undefined;
  }
  return {
    typecheck: "cargo check",
    test: "cargo test",
    lint: "",
    build: "cargo build",
    projectType: "rust",
  };
}

async function detectGo(
  root: string,
): Promise<DetectedProjectCommands | undefined> {
  if (!(await fileExists(path.join(root, "go.mod")))) {
    return undefined;
  }
  return {
    typecheck: "go vet ./...",
    test: "go test ./...",
    lint: "",
    build: "go build ./...",
    projectType: "go",
  };
}

async function detectPython(
  root: string,
): Promise<DetectedProjectCommands | undefined> {
  const markers = [
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
    "requirements.txt",
  ];
  let found = false;
  for (const marker of markers) {
    if (await fileExists(path.join(root, marker))) {
      found = true;
      break;
    }
  }
  const testsDir = path.join(root, "tests");
  if (!found && (await dirExists(testsDir))) {
    found = true;
  }
  if (!found) {
    return undefined;
  }

  const hasPytest =
    (await fileExists(path.join(root, "pytest.ini"))) ||
    (await dirExists(testsDir)) ||
    (await fileContains(path.join(root, "pyproject.toml"), /pytest/i)) ||
    (await fileContains(path.join(root, "requirements.txt"), /pytest/i));

  const hasMypy =
    (await fileExists(path.join(root, "mypy.ini"))) ||
    (await fileContains(path.join(root, "pyproject.toml"), /\[tool\.mypy\]/));
  const hasRuff =
    (await fileExists(path.join(root, "ruff.toml"))) ||
    (await fileContains(path.join(root, "pyproject.toml"), /\[tool\.ruff\]/));

  return {
    typecheck: hasMypy ? "mypy ." : "",
    test: hasPytest ? "python -m pytest" : "",
    lint: hasRuff ? "ruff check ." : "",
    build: "",
    projectType: "python",
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileContains(
  filePath: string,
  pattern: RegExp,
): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return pattern.test(raw);
  } catch {
    return false;
  }
}
