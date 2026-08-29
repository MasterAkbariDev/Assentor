import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createAssentorServices } from "../../src/services/app.js";
import { redactSecrets } from "../../src/security/redact.js";

const TEMP = path.join(process.cwd(), ".tmp", "services-tests");

describe("Assentor services", () => {
  it("boots services without copying env keys into the vault", async () => {
    await fs.mkdir(TEMP, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP, "svc-"));
    const userRoot = path.join(dir, "user-assentor");
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIzaSyServiceSeedKey9999";
    try {
      const services = await createAssentorServices(dir, { userRoot });
      expect(services.providers.has("gemini")).toBe(true);
      expect(services.agents.list().length).toBeGreaterThan(5);
      expect(
        services.vault.list().some((k) => k.name === "Env Gemini"),
      ).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it("redacts secrets in logs", () => {
    const redacted = redactSecrets("token=sk-abc123secretvaluehere");
    expect(redacted.text).not.toContain("sk-abc123secretvaluehere");
  });

  it("runs diagnostics without crashing when keys fail", async () => {
    await fs.mkdir(TEMP, { recursive: true });
    const dir = await fs.mkdtemp(path.join(TEMP, "diag-"));
    const userRoot = path.join(dir, "user-assentor");
    const services = await createAssentorServices(dir, { userRoot });
    await services.vault.add({
      provider: "gemini",
      name: "Bad",
      secret: "bad-key",
    });
    // Avoid real network: swap provider validate
    const provider = services.providers.get("gemini")!;
    vi.spyOn(provider, "validateKey").mockResolvedValue({
      valid: false,
      reachable: true,
      authenticated: false,
      modelsAvailable: false,
      message: "401 Unauthorized",
      category: "AUTHENTICATION",
    });
    const { runFullDiagnostics } = await import("../../src/services/app.js");
    const items = await runFullDiagnostics(services);
    expect(items.some((i) => i.name.startsWith("key:"))).toBe(true);
  });
});
