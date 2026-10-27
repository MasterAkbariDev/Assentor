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
import {
  ArtifactCollector,
  EvidenceKind,
  EvidencePackBuilder,
  fulfillEvidenceRequests,
} from "../../src/index.js";
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

  async function projectWithOutsideSymlink(): Promise<string> {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-outside-"));
    const target = path.join(outside, "notes.md");
    await fs.writeFile(target, layering, "utf8");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-arch-"));
    await fs.symlink(target, path.join(dir, "ARCHITECTURE.md"));
    return dir;
  }

  // Creating symlinks needs elevated rights on Windows runners.
  it.skipIf(process.platform === "win32")("ignores an architecture doc symlinked from outside the project", async () => {
    const dir = await projectWithOutsideSymlink();
    expect(await loadProjectArchitectureDoc(dir)).toBeUndefined();
  });

  // Creating symlinks needs elevated rights on Windows runners.
  it.skipIf(process.platform === "win32")("does not fulfill architecture or file requests through an outside symlink", async () => {
    const dir = await projectWithOutsideSymlink();
    const collector = new ArtifactCollector();
    const fulfillment = await fulfillEvidenceRequests(
      [
        { kind: EvidenceKind.Architecture },
        { kind: EvidenceKind.File, path: "ARCHITECTURE.md" },
      ],
      { projectPath: dir, collector },
    );
    expect(fulfillment.fulfilled).toBe(0);
    expect(collector.list()).toHaveLength(0);
  });
});

describe("requested evidence delivery", () => {
  it("puts requested files ahead of existing pack files in the prompt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assentor-req-"));
    await fs.writeFile(
      path.join(dir, "requested.ts"),
      "export const REQUESTED_MARKER = 1;\n",
      "utf8",
    );
    const pack = emptyEvidencePack(dir, { taskId: "t", round: 1 });
    pack.relevantFiles = Array.from({ length: 24 }, (_, i) => ({
      path: `src/existing${i}.ts`,
      role: "changed" as const,
      description: `changed: src/existing${i}.ts`,
      content: "y".repeat(100),
      truncated: false,
    }));
    const builder = new EvidencePackBuilder({ projectPath: dir, runCommands: false });
    const merged = await builder.mergeRequests(pack, [
      { kind: EvidenceKind.File, path: "requested.ts" },
    ]);
    expect(merged.fulfilled).toBe(1);
    expect(merged.pack.relevantFiles[0]?.path).toBe("requested.ts");
    expect(formatEvidencePackForPrompt(merged.pack)).toContain("REQUESTED_MARKER");
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
    expect(prompt).toContain(
      "File bodies for 18 collected files: 16 delivered in full, 0 partially, 2 not delivered.",
    );
    expect(prompt).toContain(
      "Not delivered (request via evidenceRequests if needed): `src/file16.ts`, `src/file17.ts`",
    );
  });

  it("counts only file bodies that survive the evidence budget", () => {
    const prompt = formatEvidencePackForPrompt(packWithFiles(16, 4_000), 20_000);
    const coverage = prompt.match(
      /File bodies for 16 collected files: (\d+) delivered in full, (\d+) partially, (\d+) not delivered\./,
    );
    expect(coverage).not.toBeNull();
    const [full, partial, omitted] = coverage!.slice(1).map(Number);
    expect(full).toBeLessThan(5);
    expect(partial).toBe(1);
    expect(full! + partial! + omitted!).toBe(16);
    // Every file reported as delivered in full really is in the prompt.
    for (let i = 0; i < full!; i += 1) {
      expect(prompt).toContain(`### src/file${i}.ts`);
    }
    expect(prompt).toContain(`Partially delivered (cut off): \`src/file${full}.ts\``);
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
