import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  detectVerificationCommands,
  resolveVerificationCommands,
} from "../../src/index.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "detect-commands");
const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("detectVerificationCommands", () => {
  it("detects pnpm + vitest scripts and tsc fallback", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", lint: "eslint .", build: "tsc" },
      }),
    );
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");

    const detected = await detectVerificationCommands(dir);
    expect(detected.projectType).toBe("node");
    expect(detected.packageManager).toBe("pnpm");
    expect(detected.test).toBe("pnpm run test");
    expect(detected.lint).toBe("pnpm run lint");
    expect(detected.build).toBe("pnpm run build");
    expect(detected.typecheck).toBe("npx tsc --noEmit");
  });

  it("prefers a typecheck script over tsc fallback", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest", typecheck: "tsc --noEmit" },
      }),
    );

    const detected = await detectVerificationCommands(dir);
    expect(detected.test).toBe("npm test");
    expect(detected.typecheck).toBe("npm run typecheck");
  });

  it("detects cargo without inventing npm scripts", async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, "Cargo.toml"), '[package]\nname = "demo"\n');

    const detected = await detectVerificationCommands(dir);
    expect(detected.projectType).toBe("rust");
    expect(detected.test).toBe("cargo test");
    expect(detected.typecheck).toBe("cargo check");
    expect(detected.build).toBe("cargo build");
    expect(detected.lint).toBe("");
  });

  it("detects go test", async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, "go.mod"), "module example.com/demo\n");

    const detected = await detectVerificationCommands(dir);
    expect(detected.projectType).toBe("go");
    expect(detected.test).toBe("go test ./...");
    expect(detected.typecheck).toBe("go vet ./...");
  });

  it("detects pytest from pyproject and tests/", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n[tool.pytest.ini_options]\n',
    );
    await fs.mkdir(path.join(dir, "tests"));

    const detected = await detectVerificationCommands(dir);
    expect(detected.projectType).toBe("python");
    expect(detected.test).toBe("python -m pytest");
  });

  it("does not invent npm test on an empty directory", async () => {
    const dir = await makeDir();
    const detected = await detectVerificationCommands(dir);
    expect(detected.test).toBe("");
    expect(detected.typecheck).toBe("");
  });

  it("lets configured commands win over detection", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const resolved = await resolveVerificationCommands(dir, {
      test: "pnpm test --filter ui",
    });
    expect(resolved.test).toBe("pnpm test --filter ui");
  });
});
