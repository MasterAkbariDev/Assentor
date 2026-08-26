import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { StoredApiKey } from "../../keys/index.js";
import type { ExecutorRow } from "./executors.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";
import type { ConfigSection } from "../keymap.js";

export const CONFIG_MENU = [
  { id: "ai" as const, label: "AI defaults (executor / reviewer / models)" },
  { id: "keys" as const, label: "API keys" },
  { id: "executors" as const, label: "Executors (install / detect)" },
  { id: "review" as const, label: "Review strategy" },
  { id: "advanced" as const, label: "Advanced routing & budgets" },
  { id: "system" as const, label: "Update / Uninstall" },
];

export function ConfigurationScreen({
  section,
  selected,
  focused,
  config,
  keys,
  executorRows,
}: {
  section: ConfigSection;
  selected: number;
  focused: boolean;
  config: AssentorConfig;
  keys: StoredApiKey[];
  executorRows: ExecutorRow[];
}) {
  if (section === "menu") {
    return (
      <Box flexDirection="column">
        <Text bold>Configure Assentor</Text>
        <Text dimColor>
          Everyday settings first. Providers and models live under AI —
          not as root destinations.
        </Text>
        <Box marginTop={1}>
          <MenuList
            items={CONFIG_MENU.map((c) => c.label)}
            selected={selected}
            focused={focused}
          />
        </Box>
      </Box>
    );
  }

  if (section === "ai" || section === "review" || section === "advanced") {
    return (
      <Box flexDirection="column">
        <Text bold>
          {section === "ai"
            ? "AI defaults"
            : section === "review"
              ? "Review"
              : "Advanced"}
        </Text>
        <Text>
          Executor <Text color="green">{config.executor.provider}</Text>
        </Text>
        <Text>
          Reviewer{" "}
          <Text color="green">{config.reviewers[0]?.provider ?? "mock"}</Text>
          {" · "}
          transport {config.reviewers[0]?.transport ?? "api"}
        </Text>
        <Text>
          Review strategy{" "}
          <Text color="green">{config.routing.reviewStrategy}</Text>
        </Text>
        <Text>
          Routing <Text color="green">{config.routing.strategy}</Text>
        </Text>
        <Text>
          Models default={config.models.default} gemini={config.models.gemini}{" "}
          openai={config.models.openai}
        </Text>
        <Text>
          Budgets rounds={config.limits.maxRounds} messages=
          {config.limits.maxMessages}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Enter opens the defaults editor · Esc back to Configure menu
          </Text>
        </Box>
      </Box>
    );
  }

  if (section === "keys") {
    if (keys.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No API keys</Text>
          <Text dimColor>
            Keys unlock Gemini / OpenAI / OpenRouter / Qwen. Stored encrypted in
            ~/.assentor.
          </Text>
          <Text dimColor>
            Press <Text color="cyan">a</Text> to add
          </Text>
        </Box>
      );
    }
    const labels = [
      "+ Add API key",
      ...keys.map(
        (k) =>
          `${k.provider.padEnd(10)} ${k.name.padEnd(16)} ${k.masked}  ${k.health}`,
      ),
    ];
    return (
      <Box flexDirection="column">
        <Text dimColor>a Add · c Check · C Check all · d Delete</Text>
        <Box marginTop={1}>
          <MenuList items={labels} selected={selected} focused={focused} />
        </Box>
      </Box>
    );
  }

  if (section === "executors") {
    const rows: ExecutorRow[] =
      executorRows.length > 0
        ? executorRows
        : [{ id: "cursor", name: "Cursor" }];
    return (
      <Box flexDirection="column">
        <Text dimColor>
          Pick an executor in AI defaults. Here you install / check CLIs.
        </Text>
        <Box marginTop={1}>
          <MenuList
            items={rows.map((r) => {
              const installed = r.detection?.installed;
              const detail = r.detection?.installed
                ? r.detection.path ?? "installed"
                : r.detection?.error ?? "Detect with r";
              return `${installed ? "✓" : "✗"} ${r.name}  ${String(detail).slice(0, 40)}`;
            })}
            selected={selected}
            focused={focused}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>r Detect all · i Install plan · Enter check one</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>System</Text>
      <MenuList
        items={["Check for updates", "Update Assentor", "Uninstall Assentor"]}
        selected={selected}
        focused={focused}
      />
      <Box marginTop={1}>
        <Badge label="caution" tone="warn" />
        <Text dimColor> Uninstall removes the CLI symlink, not project data.</Text>
      </Box>
    </Box>
  );
}
