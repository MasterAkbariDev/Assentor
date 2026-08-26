export * from "./core/index.js";
export * from "./orchestrator/index.js";
export * from "./protocol/index.js";
export * from "./artifacts/index.js";
export * from "./security/index.js";
export * from "./git/index.js";
export * from "./persistence/index.js";
export {
  AssentorConfigSchema,
  parseAssentorConfig,
  loadAssentorConfig,
  saveAssentorConfig,
  assentorConfigPath,
  projectConfigPath,
  userConfigPath,
  userAssentorDir,
  userAssentorProjectRoot,
  userSecretsPath,
  type AssentorConfig,
  type ConfigSaveScope,
} from "./config/load.js";

export type {
  Executor,
  ExecutorCapabilities,
  ExecutorTask,
  ExecutorContinuation,
  ExecutorResult,
} from "./providers/executors/types.js";
export {
  MockExecutor,
  type MockExecutorOptions,
  type MockExecutorStep,
} from "./providers/executors/mock/index.js";
export {
  killAllTrackedProcesses,
  trackChildProcess,
  trackedProcessCount,
} from "./process/tracker.js";
export { killProcessTree } from "./process/kill-tree.js";
export { runShellCommand } from "./process/run-shell.js";
export {
  CursorExecutor,
  defaultSpawn,
  resolveCursorBinary,
  isCursorAppBinary,
  type CursorExecutorOptions,
  type CursorSpawnFn,
  type CursorSpawnRequest,
  type CursorSpawnResult,
  type CursorChildHandle,
  type CursorOutputFormat,
  type AgentStatusUpdate,
} from "./providers/executors/cursor/index.js";
export {
  CursorStreamStatusParser,
  parseStreamLine,
  summarizeStreamJson,
} from "./providers/executors/cursor/stream-status.js";
export {
  ProjectMutatingExecutor,
  writeProjectFiles,
  type ProjectMutatingExecutorOptions,
  type ProjectMutationFn,
} from "./providers/executors/project-mutating/index.js";
export { withAssentorGitignore } from "./providers/executors/with-gitignore.js";

export type {
  Reviewer,
  ReviewInput,
  ReviewContinuation,
  ReviewArtifactRef,
  ReviewerTurnResult,
} from "./providers/reviewers/types.js";
export {
  MockReviewer,
  createPassingMockReviewer,
  type MockReviewerOptions,
  type MockReviewerStep,
} from "./providers/reviewers/mock/index.js";
export {
  OpenAICompatibleReviewer,
  type OpenAICompatibleReviewerOptions,
  type FetchFn,
} from "./providers/reviewers/openai/index.js";
export {
  GeminiReviewer,
  type GeminiReviewerOptions,
} from "./providers/reviewers/gemini/index.js";
export {
  CliReviewer,
  MockCliTransport,
  ProcessCliTransport,
  defaultCliSpawn,
  resolveCliAdapter,
  resolveCliBinary,
  type CliReviewerAdapter,
  type CliReviewerOptions,
  type CliTransport,
  type CliSpawnFn,
  type CliSpawnRequest,
  type CliSpawnResult,
  type MockCliTransportOptions,
  type MockCliTransportStep,
  type ProcessCliTransportOptions,
} from "./providers/reviewers/cli/index.js";
export {
  FallbackReviewer,
  isTransportFailure,
  type FallbackReviewerOptions,
} from "./providers/reviewers/fallback.js";
export {
  buildReviewPrompt,
  reviewResultFromModelText,
} from "./providers/reviewers/shared/prompt.js";

export * from "./providers/ai/index.js";
export * from "./models/index.js";
export * from "./keys/index.js";
export * from "./routing/index.js";
export * from "./executors/index.js";
export * from "./agents/index.js";
export * from "./review/index.js";
export {
  createAssentorServices,
  runFullDiagnostics,
  type AssentorServices,
  type DiagnosticItem,
} from "./services/app.js";
export { AuditLog, type AuditEvent } from "./services/audit.js";
