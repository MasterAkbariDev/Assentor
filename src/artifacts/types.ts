import { z } from "zod";

export const ArtifactType = {
  GitStatus: "git_status",
  GitDiff: "git_diff",
  ChangedFiles: "changed_files",
  File: "file",
  DirectoryListing: "directory_listing",
  CommandOutput: "command_output",
  TestResult: "test_result",
  BuildResult: "build_result",
  Log: "log",
  Screenshot: "screenshot",
  Environment: "environment",
  ProjectStructure: "project_structure",
  ExecutorSummary: "executor_summary",
  Other: "other",
} as const;

export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  path: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  source: z.enum(["executor", "reviewer", "supervisor", "git", "system"]),
  redacted: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
