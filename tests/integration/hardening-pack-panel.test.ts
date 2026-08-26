import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvidencePackBuilder,
  PanelReviewer,
  ReviewStatus,
  Supervisor,
  TaskComplexityAnalyzer,
  TaskState,
  correlateFindings,
  createBudgets,
  createEmptyContract,
  makeReviewResult,
  selectReviewers,
  DEFAULT_AGENT_PROFILES,
} from "../../src/index.js";
import { MockReviewer } from "../../src/providers/reviewers/mock/index.js";
import type { Executor, ExecutorResult } from "../../src/index.js";

describe("pack → multi-review → PASS hardening (§14)", () => {
  it("builds a pack, analyzes complexity, and panel-passes", async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "assentor-harden-"),
    );
    await fs.writeFile(
      path.join(projectPath, "package.json"),
      JSON.stringify({ name: "harden", type: "module" }),
      "utf8",
    );
    await fs.mkdir(path.join(projectPath, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "src", "ok.ts"),
      "export const ok = true;\n",
      "utf8",
    );

    const pack = await new EvidencePackBuilder({
      projectPath,
      taskId: "harden-1",
      round: 1,
      depth: "QUICK",
      runCommands: false,
    }).build();
    expect(pack.overview.projectType).toBe("node");
    await new EvidencePackBuilder({ projectPath }).persist(pack, "harden-1");

    const analysis = new TaskComplexityAnalyzer().analyze({
      taskText: "Add a small export helper",
      projectOverview: {
        projectType: pack.overview.projectType,
        framework: pack.overview.framework,
      },
    });
    expect(analysis.evidenceDepth).toBeTruthy();
    expect(analysis.recommendedCount).toBeGreaterThanOrEqual(1);

    const selected = selectReviewers(
      DEFAULT_AGENT_PROFILES,
      "SINGLE",
      "Add a small export helper",
      { min: 1, max: 2 },
    );
    expect(selected.length).toBeGreaterThanOrEqual(1);

    const members = [
      new MockReviewer({
        name: "general-reviewer",
        steps: [{ type: "pass", summary: "Looks good" }],
      }),
      new MockReviewer({
        name: "code-reviewer",
        steps: [{ type: "pass", summary: "Code ok" }],
      }),
    ];
    const panel = new PanelReviewer({
      name: "panel",
      reviewers: members,
    });

    const correlated = correlateFindings([
      {
        agentId: "general-reviewer",
        result: makeReviewResult({
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "ok",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
      {
        agentId: "code-reviewer",
        result: makeReviewResult({
          status: ReviewStatus.Pass,
          confidence: 0.9,
          summary: "ok",
          issues: [],
          requiredChanges: [],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
    ]);
    expect(correlated.length).toBeGreaterThanOrEqual(0);

    const executor: Executor = {
      name: "mock-exec",
      capabilities: () => ({
        canEditFiles: true,
        canRunCommands: true,
        canContinueSession: true,
        supportsScreenshots: false,
      }),
      async run(): Promise<ExecutorResult> {
        return { status: "completed", summary: "done", sessionId: "s1" };
      },
      async continue(): Promise<ExecutorResult> {
        return {
          status: "completed",
          summary: "explanation",
          sessionId: "s1",
          rawOutput: JSON.stringify({
            architectureSummary: "simple module",
            whatChanged: "ok.ts",
            why: "task",
            assumptions: [],
            unchanged: "n/a",
            risks: [],
            limitations: [],
          }),
        };
      },
      async cancel() {},
    };

    const result = await new Supervisor({
      projectPath,
      contract: createEmptyContract("Add a small export helper"),
      executor,
      reviewer: panel,
      budgets: createBudgets({ maxRounds: 3, maxMessages: 40 }),
      evidenceDepth: analysis.evidenceDepth,
    }).run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.finalReview?.status).toBe(ReviewStatus.Pass);
  });
});
