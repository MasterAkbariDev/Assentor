import { z } from "zod";
import { ReviewStatus, Severity } from "../core/types.js";
import { EvidenceRequestItemSchema } from "./messages.js";

export const IssueCategory = {
  Architecture: "architecture",
  Correctness: "correctness",
  Testing: "testing",
  Security: "security",
  Performance: "performance",
  Maintainability: "maintainability",
  Requirements: "requirements",
  Integration: "integration",
  Other: "other",
} as const;

export type IssueCategory = (typeof IssueCategory)[keyof typeof IssueCategory];

export const ReviewIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum([
    Severity.Blocker,
    Severity.Major,
    Severity.Minor,
    Severity.Info,
  ]),
  category: z
    .enum([
      IssueCategory.Architecture,
      IssueCategory.Correctness,
      IssueCategory.Testing,
      IssueCategory.Security,
      IssueCategory.Performance,
      IssueCategory.Maintainability,
      IssueCategory.Requirements,
      IssueCategory.Integration,
      IssueCategory.Other,
    ])
    .optional()
    .default(IssueCategory.Other),
  description: z.string().min(1),
  evidence: z.array(z.string()).optional().default([]),
  affectedFiles: z.array(z.string()).optional().default([]),
  reason: z.string().optional(),
  requiredChange: z.string().optional(),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ArchitectureAssessmentSchema = z
  .object({
    status: z.string().default("unknown"),
    summary: z.string().default(""),
  })
  .optional();

export const RequirementsAssessmentItemSchema = z.object({
  criterion: z.string().min(1),
  satisfied: z.boolean(),
  notes: z.string().optional(),
});

export const VerificationBlockSchema = z
  .object({
    tests: z.string().default("NOT_RUN"),
    build: z.string().default("NOT_RUN"),
    lint: z.string().default("NOT_RUN"),
    typecheck: z.string().default("NOT_RUN"),
  })
  .optional();

export const ReviewResultSchema = z
  .object({
    status: z.enum([
      ReviewStatus.Pass,
      ReviewStatus.NeedsWork,
      ReviewStatus.Blocked,
      ReviewStatus.Failed,
    ]),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
    architectureAssessment: ArchitectureAssessmentSchema,
    requirementsAssessment: z
      .array(RequirementsAssessmentItemSchema)
      .optional()
      .default([]),
    issues: z.array(ReviewIssueSchema).default([]),
    requiredChanges: z.array(z.string()).default([]),
    optionalChanges: z.array(z.string()).default([]),
    evidenceRequests: z.array(EvidenceRequestItemSchema).default([]),
    verification: VerificationBlockSchema,
  })
  .superRefine((value, ctx) => {
    if (value.status === ReviewStatus.Pass) {
      if (value.requiredChanges.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PASS cannot include requiredChanges",
          path: ["requiredChanges"],
        });
      }
      if (value.evidenceRequests.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PASS cannot include evidenceRequests",
          path: ["evidenceRequests"],
        });
      }
      if (
        value.issues.some(
          (issue) =>
            issue.severity === Severity.Blocker ||
            issue.severity === Severity.Major,
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PASS cannot include blocker or major issues",
          path: ["issues"],
        });
      }
    }

    if (value.status === ReviewStatus.NeedsWork) {
      if (
        value.requiredChanges.length === 0 &&
        value.issues.length === 0 &&
        value.evidenceRequests.length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "NEEDS_WORK requires issues, requiredChanges, or evidenceRequests",
          path: ["status"],
        });
      }
    }
  });

export type ReviewResult = z.input<typeof ReviewResultSchema>;
export type ReviewResultParsed = z.infer<typeof ReviewResultSchema>;

/** Build a ReviewResult with schema defaults applied (safe for object literals). */
export function makeReviewResult(
  input: z.input<typeof ReviewResultSchema>,
): ReviewResultParsed {
  return ReviewResultSchema.parse(input);
}
