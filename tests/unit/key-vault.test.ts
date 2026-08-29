import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KeyVault } from "../../src/keys/vault.js";

describe("KeyVault", () => {
  it("dedupes identical keys on load", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "vault-"));
    const vault = new KeyVault(dir);
    await vault.load();
    await vault.add({ provider: "gemini", name: "Bad", secret: "bad-key" });
    await vault.add({ provider: "gemini", name: "Bad", secret: "bad-key" });
    expect(vault.list()).toHaveLength(1);

    const reloaded = new KeyVault(dir);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });

  it("does not add duplicate rows with the same provider, name, and secret", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp", "vault-"));
    const vault = new KeyVault(dir);
    await vault.load();
    const first = await vault.add({
      provider: "gemini",
      name: "Personal",
      secret: "same-secret-value",
    });
    const second = await vault.add({
      provider: "gemini",
      name: "Personal",
      secret: "same-secret-value",
    });
    expect(second.id).toBe(first.id);
    expect(vault.list()).toHaveLength(1);
  });
});
