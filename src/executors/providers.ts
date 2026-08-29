export const SELECTABLE_EXECUTOR_PROVIDERS = [
  "mock",
  "cursor",
  "claude-code",
  "antigravity",
  "codex",
  "qwen",
  "opencode",
] as const;

export const EXECUTOR_PROVIDER_IDS = [
  ...SELECTABLE_EXECUTOR_PROVIDERS,
  "project-mutating",
] as const;

export type SelectableExecutorProvider =
  (typeof SELECTABLE_EXECUTOR_PROVIDERS)[number];
export type ExecutorProviderId = (typeof EXECUTOR_PROVIDER_IDS)[number];

export const EXECUTOR_PROVIDER_LABELS: Record<
  SelectableExecutorProvider,
  string
> = {
  mock: "Mock",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  codex: "Codex",
  qwen: "Qwen Code",
  opencode: "OpenCode",
};

const EXECUTOR_ALIASES: Record<string, ExecutorProviderId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  gemini: "antigravity",
  "gemini-cli": "antigravity",
  agy: "antigravity",
  antigravity: "antigravity",
  "google-antigravity": "antigravity",
  "cursor-agent": "cursor",
  cursor: "cursor",
  mock: "mock",
  codex: "codex",
  qwen: "qwen",
  "qwen-code": "qwen",
  opencode: "opencode",
  "project-mutating": "project-mutating",
};

export function normalizeExecutorProvider(value: string): string {
  const key = value.trim().toLowerCase();
  return EXECUTOR_ALIASES[key] ?? key;
}

export function isSelectableExecutorProvider(
  value: string,
): value is SelectableExecutorProvider {
  return (SELECTABLE_EXECUTOR_PROVIDERS as readonly string[]).includes(value);
}

export function formatExecutorProvider(id: string): string {
  if (isSelectableExecutorProvider(id)) {
    return EXECUTOR_PROVIDER_LABELS[id];
  }
  return id;
}
