import { z } from "zod";
import { ReviewStatus, Severity } from "../core/types.js";
import { EvidenceRequestItemSchema } from "./messages.js";

export const ReviewIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum([
    Severity.Blocker,
    Severity.Major,
    Severity.Minor,
    Severity.Info,
  ]),
  description: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

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
    issues: z.array(ReviewIssueSchema).default([]),
    requiredChanges: z.array(z.string()).default([]),
    optionalChanges: z.array(z.string()).default([]),
    evidenceRequests: z.array(EvidenceRequestItemSchema).default([]),
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

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
