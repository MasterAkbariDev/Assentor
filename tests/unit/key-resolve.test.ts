import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KeyVault,
  resolveProviderApiKey,
} from "../../src/keys/index.js";
import { runPreflight } from "../../src/cli/preflight.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "key-resolve-tests");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  delete process.env.GEMINI_API_KEY;
  delete process.env.ASSENTOR_GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("resolveProviderApiKey", () => {
  it("prefers env over vault", async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);
    process.env.GEMINI_API_KEY = "env-secret-value-12345";

    const vault = new KeyVault(dir);
    await vault.load();
    await vault.add({
      provider: "gemini",
      name: "vault",
      secret: "vault-secret-value-12345",
    });

    const resolved = await resolveProviderApiKey("gemini", dir);
    expect(resolved?.source).toBe("env");
    expect(resolved?.secret).toBe("env-secret-value-12345");
  });

  it("falls back to project vault", async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);

    const vault = new KeyVault(dir);
    await vault.load();
    await vault.add({
      provider: "gemini",
      name: "Personal",
      secret: "project-vault-secret-xyz",
    });

    const resolved = await resolveProviderApiKey("gemini", dir);
    expect(resolved?.source).toBe("project-vault");
    expect(resolved?.secret).toBe("project-vault-secret-xyz");
  });

  it("preflight accepts vault gemini key without env", async () => {
    await fs.mkdir(TEMP_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
    tempDirs.push(dir);

    const vault = new KeyVault(dir);
    await vault.load();
    await vault.add({
      provider: "gemini",
      name: "Personal",
      secret: "project-vault-secret-xyz",
    });

    const result = await runPreflight({
      executor: "mock",
      reviewer: "gemini",
      projectPath: dir,
    });
    const gemini = result.checks.find((c) => c.name === "reviewer:gemini");
    expect(gemini?.ok).toBe(true);
    expect(gemini?.detail).toContain("project vault");
  });
});

// silence unused os import if tree-shaken — keep for future home-vault tests
void os;
