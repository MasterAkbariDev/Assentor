import React from "react";
import { Box, Text } from "ink";
import type { LogicalAgentProfile } from "../../agents/index.js";
import type { PromptDefinition, PromptLayer, PromptLoadError } from "../../prompts/index.js";

/** Body lines the preview panel shows at once. */
export const PREVIEW_LINES = 8;

/** Load errors shown in the warning panel before "…and N more". */
export const WARNING_LINES = 3;

const ROLE_ORDER = ["builder", "reviewer", "meta"] as const;

const ROLE_TITLES: Record<PromptDefinition["role"], string> = {
  builder: "Builder prompts",
  reviewer: "Reviewer prompts",
  meta: "Meta prompts",
};

const LAYER_COLOR: Record<PromptLayer, string> = {
  builtin: "gray",
  user: "cyan",
  project: "green",
};

/**
 * Prompts in the order the screen lists them: by role, then id. Row selection
 * indexes this list, so the screen and the key handlers agree.
 */
export function orderedPrompts(prompts: readonly PromptDefinition[]): PromptDefinition[] {
  return ROLE_ORDER.flatMap((role) =>
    prompts
      .filter((prompt) => prompt.role === role)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

/** Warning-panel lines: `<layer> <file>: <message>`, first entries only. */
export function warningLines(errors: readonly PromptLoadError[], limit = WARNING_LINES): string[] {
  return errors.slice(0, limit).map((error) => `${error.layer} ${error.file}: ${error.message}`);
}

/** The result line for `validate`, the same wording the CLI prints. */
export function validateSummary(loaded: number, errorCount: number): string {
  return errorCount === 0
    ? `All prompts valid (${loaded} loaded)`
    : `${errorCount} prompt file(s) failed to load; see the warning panel`;
}

export interface AgentsScreenProps {
  agents: LogicalAgentProfile[];
  /** Index into `prompts`. */
  selected: number;
  focused: boolean;
  /** `orderedPrompts(library.list())`. */
  prompts: PromptDefinition[];
  errors: PromptLoadError[];
  loading: boolean;
  /** Set while the body preview is open; `scroll` is its first visible body line. */
  preview: { scroll: number } | null;
  forkPending: boolean;
  /** Result lines from the last fork, edit or validate action. */
  notice: string[];
}

export function AgentsScreen({
  agents,
  selected,
  focused,
  prompts,
  errors,
  loading,
  preview,
  forkPending,
  notice,
}: AgentsScreenProps) {
  // No fixed width: the Shell gives this column the space beside the nav, and
  // text inside it wraps or truncates to that space.
  const specialties = [...new Set(agents.map((agent) => agent.specialty).filter(Boolean))];
  const selectedPrompt = prompts[selected];

  return (
    <Box flexDirection="column">
      <Text bold color="white">
        🤖 Agents & Prompts
      </Text>
      <Text dimColor>
        Specialty agents: {specialties.length > 0 ? specialties.join(", ") : "none configured"}
      </Text>

      {errors.length > 0 ? <WarningPanel errors={errors} /> : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginTop={1}
      >
        <Text bold>Prompt library</Text>
        {loading ? (
          <Text dimColor>Loading prompts…</Text>
        ) : prompts.length === 0 ? (
          <Text dimColor>No prompts loaded.</Text>
        ) : (
          ROLE_ORDER.map((role) => {
            const rows = prompts.filter((prompt) => prompt.role === role);
            if (rows.length === 0) {
              return null;
            }
            return (
              <Box key={role} flexDirection="column">
                <Text bold color="cyan">
                  {ROLE_TITLES[role]}
                </Text>
                {rows.map((prompt) => (
                  <PromptRow
                    key={prompt.file}
                    prompt={prompt}
                    selected={focused && prompts.indexOf(prompt) === selected}
                  />
                ))}
              </Box>
            );
          })
        )}
      </Box>

      {preview && selectedPrompt ? (
        <PromptPreview prompt={selectedPrompt} scroll={preview.scroll} />
      ) : null}

      {forkPending && selectedPrompt ? (
        <Box marginTop={1}>
          <Text color="yellow">
            Fork &quot;{selectedPrompt.id}&quot; to: [u] user · [p] project · [Esc] cancel
          </Text>
        </Box>
      ) : null}

      {notice.slice(0, WARNING_LINES).map((line, index) => (
        <Text key={`${index}-${line}`} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function PromptRow({ prompt, selected }: { prompt: PromptDefinition; selected: boolean }) {
  return (
    <Text wrap="truncate-end" bold={selected} color={selected ? "green" : undefined}>
      {selected ? "› " : "  "}
      {prompt.id}
      <Text dimColor>{`  ${prompt.title}  `}</Text>
      <Text color={LAYER_COLOR[prompt.layer]}>[{prompt.layer}]</Text>
      {prompt.overrides ? <Text color="yellow">{`  overrides ${prompt.overrides}`}</Text> : null}
    </Text>
  );
}

function WarningPanel({ errors }: { errors: PromptLoadError[] }) {
  const lines = warningLines(errors);
  const more = errors.length - lines.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold color="yellow">
        ⚠ {errors.length} prompt file(s) failed to load
      </Text>
      {lines.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
      {more > 0 ? <Text dimColor>…and {more} more. Run assentor prompts validate.</Text> : null}
    </Box>
  );
}

function PromptPreview({ prompt, scroll }: { prompt: PromptDefinition; scroll: number }) {
  const lines = prompt.body.split("\n");
  const start = Math.min(scroll, Math.max(0, lines.length - PREVIEW_LINES));
  const visible = lines.slice(start, start + PREVIEW_LINES);
  const end = Math.min(lines.length, start + PREVIEW_LINES);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        Preview: {prompt.id} (lines {start + 1}–{end} of {lines.length})
      </Text>
      {visible.map((line, index) => (
        <Text key={start + index}>{line.length > 0 ? line : " "}</Text>
      ))}
      <Text dimColor>↑↓ scroll · ↵ close</Text>
    </Box>
  );
}
