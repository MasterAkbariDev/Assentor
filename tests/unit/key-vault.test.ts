import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installVaultSecretMirror, KeyVault } from "../../packages/engine/src/keys/vault.js";

describe("KeyVault", () => {
  it("copies keys only on request and keeps the encrypted fallback through keychain failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-mirror-"));
    const saved = new Map<string, string>();
    let available = true;
    const requireStore = () => { if (!available) throw new Error("unavailable"); };
    installVaultSecretMirror({
      async get(_directory, id) { requireStore(); return saved.get(id); },
      async set(_directory, id, secret) { requireStore(); saved.set(id, secret); },
      async delete(_directory, id) { requireStore(); saved.delete(id); },
    });
    try {
      const vault = new KeyVault(dir);
      await vault.load();
      const { id } = await vault.add({ provider: "gemini", name: "Fixture", secret: "fixture-value" });
      expect(saved.has(id)).toBe(false);
      expect(await vault.applyNativeMirror(false)).toBe(1);
      expect(saved.get(id)).toBe("fixture-value");
      available = false;
      const reloaded = new KeyVault(dir);
      await reloaded.load();
      expect((await reloaded.reveal(id)).secret).toBe("fixture-value");
      await expect(reloaded.remove(id)).rejects.toThrow("unavailable");
      expect(reloaded.get(id)).toBeDefined();
      available = true;
      expect(await reloaded.applyNativeMirror(true)).toBe(1);
      expect(saved.has(id)).toBe(false);
      expect((await reloaded.reveal(id)).secret).toBe("fixture-value");
    } finally {
      installVaultSecretMirror(undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
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
