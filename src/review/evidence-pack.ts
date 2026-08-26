import { z } from "zod";

export const RunStatusMarker = z.enum([
  "PASSED",
  "FAILED",
  "NOT_RUN",
  "SKIPPED",
  "UNKNOWN",
]);

export type RunStatusMarker = z.infer<typeof RunStatusMarker>;

export const EvidenceFileRefSchema = z.object({
  path: z.string().min(1),
  role: z
    .enum([
      "changed",
      "dependency",
      "caller",
      "implementation",
      "test",
      "config",
      "relevant",
      "unchanged_important",
    ])
    .default("relevant"),
  description: z.string().optional(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
});

export type EvidenceFileRef = z.infer<typeof EvidenceFileRefSchema>;

export const ProjectOverviewSchema = z.object({
  projectType: z.string().optional(),
  language: z.string().optional(),
  framework: z.string().optional(),
  runtime: z.string().optional(),
  packageManager: z.string().optional(),
  buildSystem: z.string().optional(),
  testFramework: z.string().optional(),
  linting: z.array(z.string()).default([]),
  majorDependencies: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const ProjectStructureSchema = z.object({
  tree: z.string().default(""),
  rootFiles: z.array(z.string()).default([]),
  omitted: z.array(z.string()).default([]),
});

export const ArchitectureSummarySchema = z.object({
  summary: z.string().default(""),
  modules: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  dataFlow: z.string().optional(),
  abstractions: z.array(z.string()).default([]),
  source: z.enum(["assentor", "executor", "mixed", "missing"]).default("missing"),
});

export const DependencyInfoSchema = z.object({
  manifestPath: z.string().optional(),
  manifestExcerpt: z.string().optional(),
  scripts: z.record(z.string()).default({}),
  relevantConfigPaths: z.array(z.string()).default([]),
  configExcerpts: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .default([]),
});

export const GitInfoSchema = z.object({
  isRepo: z.boolean().default(false),
  branch: z.string().optional(),
  commit: z.string().optional(),
  /** HEAD recorded at task start — diffs are computed against this. */
  baselineCommit: z.string().optional(),
  status: z.string().optional(),
  workingTreeClean: z.boolean().optional(),
  changedFiles: z.array(z.string()).default([]),
  diff: z.string().optional(),
  recentLog: z.string().optional(),
  note: z.string().optional(),
});

export const CommandRunSchema = z.object({
  status: RunStatusMarker.default("NOT_RUN"),
  command: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().optional(),
});

export const TestInfoSchema = z.object({
  relevantTests: z.array(z.string()).default([]),
  test: CommandRunSchema.default({}),
  build: CommandRunSchema.default({}),
  lint: CommandRunSchema.default({}),
  typecheck: CommandRunSchema.default({}),
});

export const ConfigInfoSchema = z.object({
  envVarNames: z.array(z.string()).default([]),
  featureFlags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /** Paths only — never secret values */
  configPaths: z.array(z.string()).default([]),
});

export const RuntimeInfoSchema = z.object({
  errors: z.array(z.string()).default([]),
  logs: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const ExecutorExplanationSchema = z.object({
  whatChanged: z.string().optional(),
  why: z.string().optional(),
  assumptions: z.array(z.string()).default([]),
  unchanged: z.string().optional(),
  risks: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  raw: z.string().optional(),
  source: z.enum(["executor", "missing"]).default("missing"),
});

/**
 * Structured Project Review Evidence Pack (sections A–K).
 * Optional fields + NOT_RUN markers — never invent missing evidence.
 */
export const ProjectReviewEvidencePackSchema = z.object({
  version: z.literal(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectPath: z.string(),
  taskId: z.string().optional(),
  round: z.number().int().nonnegative().default(0),
  depth: z.enum(["QUICK", "STANDARD", "DEEP", "CUSTOM"]).default("STANDARD"),
  overview: ProjectOverviewSchema.default({}),
  structure: ProjectStructureSchema.default({}),
  architecture: ArchitectureSummarySchema.default({}),
  relevantFiles: z.array(EvidenceFileRefSchema).default([]),
  unchangedImportant: z.array(EvidenceFileRefSchema).default([]),
  dependencies: DependencyInfoSchema.default({}),
  git: GitInfoSchema.default({}),
  tests: TestInfoSchema.default({}),
  configuration: ConfigInfoSchema.default({}),
  runtime: RuntimeInfoSchema.default({}),
  executorExplanation: ExecutorExplanationSchema.default({}),
  notes: z.array(z.string()).default([]),
});

export type ProjectReviewEvidencePack = z.infer<
  typeof ProjectReviewEvidencePackSchema
>;

export function emptyEvidencePack(
  projectPath: string,
  options: {
    taskId?: string;
    round?: number;
    depth?: ProjectReviewEvidencePack["depth"];
  } = {},
): ProjectReviewEvidencePack {
  const now = new Date().toISOString();
  return ProjectReviewEvidencePackSchema.parse({
    version: 1,
    createdAt: now,
    updatedAt: now,
    projectPath,
    taskId: options.taskId,
    round: options.round ?? 0,
    depth: options.depth ?? "STANDARD",
  });
}
