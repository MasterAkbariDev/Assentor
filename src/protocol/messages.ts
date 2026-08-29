import { z } from "zod";

/**
 * Structured protocol message types.
 * Agents communicate through these — not free-form text alone.
 */
export const MessageType = {
  Task: "TASK",
  Status: "STATUS",
  Question: "QUESTION",
  Answer: "ANSWER",
  EvidenceRequest: "EVIDENCE_REQUEST",
  EvidenceResponse: "EVIDENCE_RESPONSE",
  ChangeRequest: "CHANGE_REQUEST",
  InvestigationRequest: "INVESTIGATION_REQUEST",
  TestRequest: "TEST_REQUEST",
  BuildRequest: "BUILD_REQUEST",
  ClarificationRequest: "CLARIFICATION_REQUEST",
  Warning: "WARNING",
  Pass: "PASS",
  Fail: "FAIL",
  Blocked: "BLOCKED",
  Abort: "ABORT",
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MessageTypeSchema = z.enum([
  MessageType.Task,
  MessageType.Status,
  MessageType.Question,
  MessageType.Answer,
  MessageType.EvidenceRequest,
  MessageType.EvidenceResponse,
  MessageType.ChangeRequest,
  MessageType.InvestigationRequest,
  MessageType.TestRequest,
  MessageType.BuildRequest,
  MessageType.ClarificationRequest,
  MessageType.Warning,
  MessageType.Pass,
  MessageType.Fail,
  MessageType.Blocked,
  MessageType.Abort,
]);

export const EvidenceKind = {
  File: "file",
  Files: "files",
  Directory: "directory",
  DirectoryTree: "directory_tree",
  GitDiff: "git_diff",
  GitLog: "git_log",
  Command: "command",
  Test: "test",
  Build: "build",
  Lint: "lint",
  Typecheck: "typecheck",
  Screenshot: "screenshot",
  Log: "log",
  Logs: "logs",
  Environment: "environment",
  Config: "config",
  ProjectStructure: "project_structure",
  SceneHierarchy: "scene_hierarchy",
  McpInspection: "mcp_inspection",
  Symbol: "symbol",
  Callers: "callers",
  Implementations: "implementations",
  Dependencies: "dependencies",
  Search: "search",
  Architecture: "architecture",
  RuntimeInformation: "runtime_information",
  CommandOutput: "command_output",
} as const;

export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

export const EvidenceRequestItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(EvidenceKind.File),
    path: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Files),
    paths: z.array(z.string().min(1)).min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Directory),
    path: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.DirectoryTree),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.GitDiff),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.GitLog),
    description: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Command),
    command: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.CommandOutput),
    command: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Test),
    command: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Build),
    command: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Lint),
    command: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Typecheck),
    command: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Screenshot),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Log),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Logs),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Environment),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Config),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.ProjectStructure),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.SceneHierarchy),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.McpInspection),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Symbol),
    symbol: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Callers),
    symbol: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Implementations),
    symbol: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Dependencies),
    path: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Search),
    query: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.Architecture),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal(EvidenceKind.RuntimeInformation),
    description: z.string().optional(),
  }),
]);

export type EvidenceRequestItem = z.infer<typeof EvidenceRequestItemSchema>;

export const EvidenceArtifactSchema = z.object({
  requestIndex: z.number().int().nonnegative().optional(),
  kind: z.string().min(1),
  path: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  redacted: z.boolean().optional(),
});

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

const TaskPayloadSchema = z.object({
  goal: z.string().min(1),
  contract: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});

const StatusPayloadSchema = z.object({
  status: z.string().min(1),
  summary: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
});

const QuestionPayloadSchema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const AnswerPayloadSchema = z.object({
  answer: z.string().min(1),
  inReplyTo: z.string().optional(),
});

const EvidenceRequestPayloadSchema = z.object({
  requests: z.array(EvidenceRequestItemSchema).min(1),
  reason: z.string().optional(),
});

const EvidenceResponsePayloadSchema = z.object({
  artifacts: z.array(EvidenceArtifactSchema).min(1),
  inReplyTo: z.string().optional(),
  notes: z.string().optional(),
});

const ChangeRequestPayloadSchema = z.object({
  summary: z.string().min(1),
  requiredChanges: z.array(z.string()).default([]),
  optionalChanges: z.array(z.string()).default([]),
  issueIds: z.array(z.string()).default([]),
  nextPhaseDirective: z.string().optional(),
});

const InvestigationRequestPayloadSchema = z.object({
  hypothesis: z.string().min(1),
  questions: z.array(z.string()).min(1),
  focusPaths: z.array(z.string()).default([]),
});

const TestRequestPayloadSchema = z.object({
  command: z.string().min(1).optional(),
  description: z.string().min(1),
});

const BuildRequestPayloadSchema = z.object({
  command: z.string().min(1).optional(),
  description: z.string().min(1),
});

const ClarificationRequestPayloadSchema = z.object({
  question: z.string().min(1),
  whyNeeded: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const WarningPayloadSchema = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
});

const DecisionPayloadSchema = z.object({
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  details: z.string().optional(),
});

const BlockedPayloadSchema = z.object({
  reason: z.string().min(1),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const AbortPayloadSchema = z.object({
  reason: z.string().min(1),
});

export const MessagePayloadByType = {
  [MessageType.Task]: TaskPayloadSchema,
  [MessageType.Status]: StatusPayloadSchema,
  [MessageType.Question]: QuestionPayloadSchema,
  [MessageType.Answer]: AnswerPayloadSchema,
  [MessageType.EvidenceRequest]: EvidenceRequestPayloadSchema,
  [MessageType.EvidenceResponse]: EvidenceResponsePayloadSchema,
  [MessageType.ChangeRequest]: ChangeRequestPayloadSchema,
  [MessageType.InvestigationRequest]: InvestigationRequestPayloadSchema,
  [MessageType.TestRequest]: TestRequestPayloadSchema,
  [MessageType.BuildRequest]: BuildRequestPayloadSchema,
  [MessageType.ClarificationRequest]: ClarificationRequestPayloadSchema,
  [MessageType.Warning]: WarningPayloadSchema,
  [MessageType.Pass]: DecisionPayloadSchema,
  [MessageType.Fail]: DecisionPayloadSchema,
  [MessageType.Blocked]: BlockedPayloadSchema,
  [MessageType.Abort]: AbortPayloadSchema,
} as const;

const EnvelopeBaseSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  round: z.number().int().nonnegative(),
  from: z.string().min(1),
  to: z.string().min(1),
  requiresResponse: z.boolean(),
  timestamp: z.string().datetime({ offset: true }),
});

export const ProtocolMessageSchema = z.discriminatedUnion("type", [
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Task),
    content: TaskPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Status),
    content: StatusPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Question),
    content: QuestionPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Answer),
    content: AnswerPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.EvidenceRequest),
    content: EvidenceRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.EvidenceResponse),
    content: EvidenceResponsePayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.ChangeRequest),
    content: ChangeRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.InvestigationRequest),
    content: InvestigationRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.TestRequest),
    content: TestRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.BuildRequest),
    content: BuildRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.ClarificationRequest),
    content: ClarificationRequestPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Warning),
    content: WarningPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Pass),
    content: DecisionPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Fail),
    content: DecisionPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Blocked),
    content: BlockedPayloadSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal(MessageType.Abort),
    content: AbortPayloadSchema,
  }),
]);

export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;

export type MessageContent<T extends MessageType> = z.infer<
  (typeof MessagePayloadByType)[T]
>;
