import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandRelatedModuleFiles,
  isArchitectureHeavyTask,
  loadProjectArchitectureDoc,
  parseArchitectureSummary,
  parseExecutorExplanation,
} from "../../src/review/pack-builder.js";
import { emptyEvidencePack } from "../../src/review/evidence-pack.js";
import { formatEvidencePackForPrompt } from "../../src/providers/reviewers/shared/prompt.js";

describe("local evidence parsing", () => {
  it("extracts architecture summary from executor JSON output", () => {
    const text = JSON.stringify({
      architectureSummary: "Supervisor owns the loop",
      whatChanged: "src/orchestrator/supervisor.ts",
    });
    expect(parseArchitectureSummary(text)).toBe("Supervisor owns the loop");
    expect(parseExecutorExplanation(text).whatChanged).toContain("supervisor.ts");
  });

  it("extracts architecture summary from prose Section C blocks", () => {
    const text = [
      "### Section C: Architecture Summary",
      "The Finora mobile app uses Clean Architecture with Riverpod providers.",
      "",
      "### Section D: Inlined File Contents",
      "#### 1. docs/architecture.md",
    ].join("\n");
    expect(parseArchitectureSummary(text)).toContain("Clean Architecture");
  });

  it("extracts architecture summary from layering prose", () => {
    const text = [
      "Presentation Layer uses Riverpod notifiers.",
      "Domain Layer holds repository interfaces.",
      "Data Layer implements Hive persistence.",
    ].join("\n");
    expect(parseArchitectureSummary(text)).toContain("Presentation Layer");
  });

  it("detects architecture-heavy tasks", () => {
    expect(isArchitectureHeavyTask("Refactor wallets repository layering")).toBe(true);
    expect(isArchitectureHeavyTask("Fix button color")).toBe(false);
  });

  it("expands related module files from changed feature paths", () => {
    const related = expandRelatedModuleFiles([
      "apps/mobile/lib/features/wallets/presentation/providers/wallets_providers.dart",
    ]);
    expect(related).toContain(
      "apps/mobile/lib/features/wallets/domain/repositories/wallets_repository.dart",
    );
    expect(related).toContain(
      "apps/mobile/lib/features/wallets/data/repositories/wallets_repository_impl.dart",
    );
  });
});

describe("architecture doc fallback", () => {
  const layering =
    "The presentation layer depends on the domain layer only; data implements domain repositories.";

  it("redacts secrets in the architecture doc", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-arch-"));
    await fs.writeFile(
      path.join(dir, "ARCHITECTURE.md"),
      `${layering}\nAPI_KEY=supersecretvalue123\n`,
      "utf8",
    );
    const doc = await loadProjectArchitectureDoc(dir);
    expect(doc).toContain("presentation layer");
    expect(doc).not.toContain("supersecretvalue123");
  });

  it("ignores an architecture doc symlinked from outside the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-outside-"));
    const target = path.join(outside, "notes.md");
    await fs.writeFile(target, layering, "utf8");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-arch-"));
    await fs.symlink(target, path.join(dir, "ARCHITECTURE.md"));
    expect(await loadProjectArchitectureDoc(dir)).toBeUndefined();
  });
});

describe("evidence pack prompt budget", () => {
  function packWithFiles(count: number, size: number) {
    const pack = emptyEvidencePack("/tmp/p", { taskId: "t", round: 1 });
    pack.relevantFiles = Array.from({ length: count }, (_, i) => ({
      path: `src/file${i}.ts`,
      role: "changed" as const,
      description: `changed: src/file${i}.ts`,
      content: "x".repeat(size),
      truncated: false,
    }));
    return pack;
  }

  it("lists files that were collected but not inlined", () => {
    const prompt = formatEvidencePackForPrompt(packWithFiles(18, 10));
    expect(prompt).toContain("Inlined 16 of 18 collected files.");
    expect(prompt).toContain("`src/file16.ts`, `src/file17.ts`");
  });

  it("keeps the stall signal and executor claims when evidence is truncated", () => {
    const pack = packWithFiles(16, 8_000);
    pack.executorStalledWaitingForConfirmation = true;
    pack.executorExplanation.whatChanged = "Moved auth into the service layer";
    const prompt = formatEvidencePackForPrompt(pack, 20_000);
    expect(prompt.length).toBeLessThanOrEqual(20_000 + 32);
    expect(prompt).toContain("Do NOT PASS");
    expect(prompt).toContain("Moved auth into the service layer");
    expect(prompt).toContain("cut to fit the prompt budget");
  });
});
