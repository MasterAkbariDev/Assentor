import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import { userConfigPath, userSecretsPath } from "../../config/paths.js";
import { Dialog } from "../components/dialog.js";
import { MenuList } from "./shared.js";

export const EXECUTOR_OPTIONS = ["mock", "cursor"] as const;
export const REVIEWER_OPTIONS = ["mock", "gemini", "openai"] as const;
export const ROUTING_OPTIONS = [
  "FREE_FIRST",
  "CHEAPEST",
  "BALANCED",
  "BEST",
  "CUSTOM",
] as const;
export const REVIEW_STRATEGY_OPTIONS = [
  "SINGLE",
  "ADAPTIVE",
  "PANEL",
  "FULL",
] as const;
export const ROUND_OPTIONS = [4, 6, 8, 10, 12, 16] as const;

export function buildDefaultRows(config: AssentorConfig): string[] {
  return [
    `Executor:           ${config.executor.provider}`,
    `Reviewer:           ${config.reviewers[0]?.provider ?? "mock"}`,
    `Routing strategy:   ${config.routing.strategy}`,
    `Review strategy:    ${config.routing.reviewStrategy}`,
    `Default model:      ${config.models.default}`,
    `Gemini model:       ${config.models.gemini}`,
    `OpenAI model:       ${config.models.openai}`,
    `Max rounds:         ${config.limits.maxRounds}`,
    "Save defaults to ~/.assentor/config.yaml (global)",
  ];
}

export function SettingsScreen({
  selected,
  focused,
  dialog,
  config,
  projectPath,
  defaultSelected,
}: {
  selected: number;
  focused: boolean;
  dialog: "none" | "defaults";
  config: AssentorConfig;
  projectPath: string;
  defaultSelected: number;
}) {
  if (dialog === "defaults") {
    return (
      <Dialog title="Defaults">
        <Text dimColor>← → cycle · Enter cycles or Save · Esc close</Text>
        <MenuList
          items={buildDefaultRows(config)}
          selected={defaultSelected}
          focused
        />
        <Box marginTop={1}>
          <Text color="green">
            {`assentor run → ${config.executor.provider} + ${config.reviewers[0]?.provider}`}
          </Text>
        </Box>
        <Text dimColor>Workspace: {projectPath}</Text>
      </Dialog>
    );
  }

  return (
    <Box flexDirection="column">
      <MenuList
        focused={focused}
        selected={selected}
        items={[
          "Defaults (executor / reviewer / models)…",
          `Global: ${userConfigPath()}`,
          `Secrets: ${userSecretsPath()}`,
        ]}
      />
      <Text dimColor>
        Defaults and API keys are global (~/.assentor). Project folders store
        task state when you run.
      </Text>
    </Box>
  );
}
