import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { StoredApiKey } from "../../keys/index.js";
import type { ExecutorRow } from "./executors.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";
import {
  buildAdvancedRows,
  buildAiRows,
  buildReviewRows,
} from "./settings.js";
import type { ConfigSection } from "../keymap.js";

export const CONFIG_MENU = [
  { id: "ai" as const, label: "AI defaults (executor, models)" },
  { id: "keys" as const, label: "API keys" },
  { id: "executors" as const, label: "Executors (install / detect)" },
  { id: "review" as const, label: "Reviewers (add Gemini, Claude, …)" },
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
  envHints = [],
}: {
  section: ConfigSection;
  selected: number;
  focused: boolean;
  config: AssentorConfig;
  keys: StoredApiKey[];
  executorRows: ExecutorRow[];
  envHints?: Array<{ provider: string; envName: string }>;
}) {
  if (section === "menu") {
    return (
      <Box flexDirection="column">
        <Text bold>Configure Assentor</Text>
        <Text dimColor>
          Add reviewers one by one (API key or CLI). Executor lives under AI.
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

  if (section === "review") {
    return (
      <Box flexDirection="column">
        <Text bold>Reviewers</Text>
        <Text dimColor>
          Each row is someone who reviews the executor. Mix API and CLI — e.g.
          Gemini via a key, Claude via the Claude CLI.
        </Text>
        <Box marginTop={1}>
          <MenuList
            items={buildReviewRows(config)}
            selected={selected}
            focused={focused}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            a Add · d Delete · ← → how many / rounds · s save · Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  if (section === "ai" || section === "advanced") {
    const rows =
      section === "ai" ? buildAiRows(config) : buildAdvancedRows(config);
    const title = section === "ai" ? "AI defaults" : "Advanced";
    const hint =
      section === "ai"
        ? "Who writes code, and which model. Add reviewers under Reviewers."
        : "Routing and budgets. Leave Balanced unless you have a reason.";
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>{hint}</Text>
        <Box marginTop={1}>
          <MenuList items={rows} selected={selected} focused={focused} />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ← → change · Enter same as → · s save · Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  if (section === "keys") {
    const envLine =
      envHints.length > 0
        ? `Also from environment: ${envHints.map((h) => `$${h.envName}`).join(", ")}`
        : null;
    if (keys.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No API keys</Text>
          <Text dimColor>
            Keys you add here unlock Gemini / OpenAI / OpenRouter / Qwen.
            Stored encrypted in ~/.assentor — not copied from env vars.
          </Text>
          {envLine ? <Text dimColor>{envLine}</Text> : null}
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
        {envLine ? <Text dimColor>{envLine}</Text> : null}
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
