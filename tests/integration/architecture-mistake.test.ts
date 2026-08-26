import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IssueCategory,
  MessageType,
  PanelReviewer,
  ProjectMutatingExecutor,
  ReviewStatus,
  Severity,
  Supervisor,
  TaskState,
  correlateFindings,
  createBudgets,
  createEmptyContract,
  makeReviewResult,
  securityVeto,
  writeProjectFiles,
} from "../../src/index.js";
import { MockReviewer } from "../../src/providers/reviewers/mock/index.js";

const TEMP_ROOT = path.join(process.cwd(), ".tmp", "architecture-mistake");
const tempDirs: string[] = [];

const BROKEN_SERVICE = `import { db } from "../infra/db.js";

/** Intentionally bypasses UserRepository — architecture mistake. */
export async function getUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}
`;

const FIXED_SERVICE = `import type { UserRepository } from "../domain/UserRepository.js";

export async function getUser(repo: UserRepository, id: string) {
  return repo.findById(id);
}
`;

async function seedArchitectureFixture(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "proj-"));
  tempDirs.push(dir);

  await writeProjectFiles(dir, {
    "package.json": JSON.stringify(
      {
        name: "architecture-mistake-fixture",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
    "src/domain/UserRepository.ts": `export interface UserRepository {
  findById(id: string): Promise<{ id: string; name: string } | null>;
}
`,
    "src/infra/DbUserRepository.ts": `import type { UserRepository } from "../domain/UserRepository.js";
import { db } from "./db.js";

export class DbUserRepository implements UserRepository {
  async findById(id: string) {
    return db.query("SELECT * FROM users WHERE id = ?", [id]);
  }
}
`,
    "src/infra/db.ts": `export const db = {
  async query(_sql: string, _params: unknown[]) {
    return { id: "1", name: "demo" };
  },
};
`,
    "src/api/users.ts": `import { getUser } from "../services/UserService.js";
import { DbUserRepository } from "../infra/DbUserRepository.js";

export async function handleGetUser(id: string) {
  const repo = new DbUserRepository();
  // Caller still expects repository-based service API
  return getUser(id as never);
}
`,
    "src/services/UserService.ts": `export async function getUser(_id: string) {
  throw new Error("not implemented");
}
`,
  });

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Spec §42 — architecture mistake detected by specialty reviewer,
 * correlated across the panel, fixed, then PASS (offline mocks).
 */
describe("architecture mistake fixture (§42)", () => {
  it("detects → correlates → fix round → PASS", async () => {
    const projectPath = await seedArchitectureFixture();

    const architecture = new MockReviewer({
      name: "architecture-reviewer",
      steps: [
        {
          type: "custom",
          result: makeReviewResult({
            status: ReviewStatus.NeedsWork,
            confidence: 0.92,
            summary:
              "UserService bypasses UserRepository and talks to db directly",
            architectureAssessment: {
              status: "concern",
              summary: "Layering violation: service → db skips repository",
            },
            issues: [
              {
                id: "ARCH-001",
                severity: Severity.Major,
                category: IssueCategory.Architecture,
                description:
                  "UserService bypasses UserRepository interface and queries db directly",
                evidence: [
                  "src/services/UserService.ts",
                  "src/domain/UserRepository.ts",
                ],
                affectedFiles: [
                  "src/services/UserService.ts",
                  "src/domain/UserRepository.ts",
                  "src/api/users.ts",
                ],
                requiredChange:
                  "Route UserService through UserRepository; do not import infra/db",
              },
            ],
            requiredChanges: [
              "Fix UserService to depend on UserRepository instead of db",
            ],
            optionalChanges: [],
            evidenceRequests: [],
          }),
        },
        {
          type: "pass",
          summary: "Architecture boundaries restored",
        },
      ],
    });

    const code = new MockReviewer({
      name: "code-reviewer",
      steps: [
        {
          type: "custom",
          result: makeReviewResult({
            status: ReviewStatus.NeedsWork,
            confidence: 0.8,
            summary: "Service incorrectly imports infrastructure db",
            issues: [
              {
                id: "CODE-ARCH-1",
                severity: Severity.Major,
                category: IssueCategory.Architecture,
                description:
                  "UserService should not import db; use UserRepository abstraction",
                evidence: ["src/services/UserService.ts"],
                affectedFiles: ["src/services/UserService.ts"],
              },
            ],
            requiredChanges: [
              "Depend on UserRepository rather than infra/db in UserService",
            ],
            optionalChanges: [],
            evidenceRequests: [],
          }),
        },
        { type: "pass", summary: "Code looks correct after fix" },
      ],
    });

    const general = new MockReviewer({
      name: "general-reviewer",
      steps: [
        { type: "pass", summary: "Acceptance criteria otherwise ok" },
        { type: "pass", summary: "Still ok after fix" },
      ],
    });

    const panel = new PanelReviewer({
      name: "panel:architecture-fixture",
      reviewers: [architecture, code, general],
      goal: "Implement getUser via repository boundaries",
      acceptanceCriteria: [
        "UserService uses UserRepository",
        "Unchanged repo interface remains the contract",
      ],
    });

    const executor = new ProjectMutatingExecutor({
      mutate: async ({ projectPath: cwd, messages }) => {
        const isExplanation = (messages ?? []).some((message) => {
          if (message.type !== MessageType.Question) return false;
          const content = message.content as {
            purpose?: string;
            context?: string;
            question?: string;
          };
          return (
            content.purpose === "evidence_pack_explanation" ||
            content.context === "purpose:evidence_pack_explanation" ||
            (typeof content.question === "string" &&
              content.question.toLowerCase().includes("architecture"))
          );
        });
        if (isExplanation) {
          const fixedOnDisk = await fs
            .readFile(path.join(cwd, "src/services/UserService.ts"), "utf8")
            .then((t) => t.includes("UserRepository"))
            .catch(() => false);
          return {
            summary: "explanation",
            rawOutput: JSON.stringify({
              architectureSummary: fixedOnDisk
                ? "Service uses UserRepository"
                : "Service queries db directly (mistake)",
              whatChanged: fixedOnDisk
                ? "Routed getUser through UserRepository"
                : "Implemented getUser against db",
              why: "task",
              assumptions: [],
              unchanged: "UserRepository, DbUserRepository",
              risks: [],
              limitations: [],
            }),
          };
        }

        // First non-explanation mutation writes the architecture mistake;
        // subsequent mutations apply the fix.
        const servicePath = path.join(cwd, "src/services/UserService.ts");
        const current = await fs.readFile(servicePath, "utf8").catch(() => "");
        const alreadyBroken = current.includes("db.query");
        const alreadyFixed = current.includes("UserRepository");

        if (!alreadyBroken && !alreadyFixed) {
          await writeProjectFiles(cwd, {
            "src/services/UserService.ts": BROKEN_SERVICE,
            "src/api/users.ts": `import { getUser } from "../services/UserService.js";

export async function handleGetUser(id: string) {
  return getUser(id);
}
`,
          });
          return { summary: "Implemented getUser (bypassing repository)" };
        }

        await writeProjectFiles(cwd, {
          "src/services/UserService.ts": FIXED_SERVICE,
          "src/api/users.ts": `import { getUser } from "../services/UserService.js";
import { DbUserRepository } from "../infra/DbUserRepository.js";

export async function handleGetUser(id: string) {
  return getUser(new DbUserRepository(), id);
}
`,
        });
        return { summary: "Fixed architecture: service uses UserRepository" };
      },
    });

    const supervisor = new Supervisor({
      projectPath,
      contract: createEmptyContract(
        "Implement getUser respecting UserRepository architecture boundaries",
      ),
      executor,
      reviewer: panel,
      budgets: createBudgets({ maxRounds: 4, maxMessages: 40 }),
      collectExecutorExplanation: true,
      evidenceDepth: "STANDARD",
    });

    const result = await supervisor.run();

    expect(result.status).toBe(TaskState.Done);
    expect(result.round).toBeGreaterThanOrEqual(2);
    expect(result.finalReview?.status).toBe(ReviewStatus.Pass);
    expect(architecture.callCount).toBeGreaterThanOrEqual(2);
    expect(code.callCount).toBeGreaterThanOrEqual(2);

    const fixed = await fs.readFile(
      path.join(projectPath, "src/services/UserService.ts"),
      "utf8",
    );
    expect(fixed).toContain("UserRepository");
    expect(fixed).not.toContain('from "../infra/db');
  });

  it("correlates overlapping architecture findings and security-vetoes majority PASS", () => {
    const findings = [
      {
        agentId: "architecture-reviewer",
        result: makeReviewResult({
          status: ReviewStatus.NeedsWork,
          confidence: 0.9,
          summary: "boundary",
          issues: [
            {
              id: "A1",
              severity: Severity.Major,
              category: IssueCategory.Architecture,
              description: "Service bypasses UserRepository and hits db",
              affectedFiles: ["src/services/UserService.ts"],
              evidence: ["src/services/UserService.ts"],
            },
          ],
          requiredChanges: ["Use repository"],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
      {
        agentId: "code-reviewer",
        result: makeReviewResult({
          status: ReviewStatus.NeedsWork,
          confidence: 0.85,
          summary: "boundary",
          issues: [
            {
              id: "C1",
              severity: Severity.Major,
              category: IssueCategory.Architecture,
              description:
                "UserService bypasses the UserRepository abstraction to query db",
              affectedFiles: ["src/services/UserService.ts"],
              evidence: ["diff"],
            },
          ],
          requiredChanges: ["Depend on UserRepository"],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
    ];

    const correlated = correlateFindings(findings);
    expect(correlated.length).toBe(1);
    expect(correlated[0]!.agentIds).toEqual(
      expect.arrayContaining([
        "architecture-reviewer",
        "code-reviewer",
      ]),
    );

    const veto = securityVeto([
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
      {
        agentId: "security-reviewer",
        result: makeReviewResult({
          status: ReviewStatus.NeedsWork,
          confidence: 0.95,
          summary: "secret leak",
          issues: [
            {
              id: "SEC-1",
              severity: Severity.Blocker,
              category: IssueCategory.Security,
              description: "Hardcoded API token in service",
              evidence: ["src/services/UserService.ts"],
              affectedFiles: ["src/services/UserService.ts"],
            },
          ],
          requiredChanges: ["Remove hardcoded token"],
          optionalChanges: [],
          evidenceRequests: [],
        }),
      },
    ]);

    expect(veto?.status).toBe(ReviewStatus.NeedsWork);
    expect(veto?.summary).toMatch(/Security veto/i);
  });
});
