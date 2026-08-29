import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { StoredApiKey } from "../../keys/index.js";
import type { ExecutorRow } from "./executors.js";
import { Badge } from "../components/badge.js";
import { Card } from "../components/panel.js";
import { CycleSelector } from "../components/cycle-selector.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";
import {
  buildAdvancedStructuredFields,
  buildAiStructuredFields,
  buildReviewMenu,
} from "./settings.js";
import { providerIcon } from "./shared.js";
import type { ConfigSection } from "../keymap.js";

export const CONFIG_MENU = [
  { id: "ai" as const, label: "AI Defaults", icon: "🤖", description: "Mode (Supervised/Autopilot), executor CLI, and LLM models" },
  { id: "keys" as const, label: "API Keys Vault", icon: "🔑", description: "Manage encrypted API keys for Gemini, OpenAI, Claude, Qwen" },
  { id: "executors" as const, label: "Executors Hub", icon: "💻", description: "Inspect detected coding agent CLIs on PATH and install plans" },
  { id: "review" as const, label: "Reviewers Team", icon: "🛡", description: "Configure multi-agent panel (Gemini API, Claude CLI, Cursor)" },
  { id: "advanced" as const, label: "Advanced Routing & Budgets", icon: "⚙", description: "Cost optimization, max rounds, and message limits" },
  { id: "system" as const, label: "System & Updates", icon: "🚀", description: "Check for new releases, update binary, or manage install" },
];

export function ConfigurationScreen({
  section,
  selected,
  focused,
  config,
  keys,
  executorRows,
  installedIds,
  envHints = [],
}: {
  section: ConfigSection;
  selected: number;
  focused: boolean;
  config: AssentorConfig;
  keys: StoredApiKey[];
  executorRows: ExecutorRow[];
  installedIds?: ReadonlySet<string>;
  envHints?: Array<{ provider: string; envName: string }>;
}) {
  if (section === "menu") {
    const items: ScrollListItem[] = CONFIG_MENU.map((c) => ({
      id: c.id,
      icon: c.icon,
      label: c.label,
      description: c.description,
    }));

    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            ⚙ Assentor Configuration Studio
          </Text>
          <Text dimColor>
            Press <Text color="green" bold>s</Text> to save defaults to ~/.assentor
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={focused ? "green" : "gray"}
          paddingX={1}
          flexDirection="column"
        >
          <ScrollList
            items={items}
            selected={selected}
            focused={focused}
            maxVisible={6}
          />
        </Box>
      </Box>
    );
  }

  if (section === "review") {
    const reviewMenu = buildReviewMenu(config);
    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            🛡 Reviewers Team Composition ({config.reviewers.length} configured)
          </Text>
          <Text dimColor>
            <Text color="green" bold>a</Text> Add · <Text color="red" bold>d</Text> Delete · <Text color="cyan" bold>←→</Text> Cycle · <Text color="green" bold>s</Text> Save · <Text color="yellow" bold>Esc</Text> Back
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={focused ? "green" : "gray"}
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          {reviewMenu.map((row, index) => {
            const active = index === selected;
            if (row.kind === "add") {
              return (
                <Box key="add" flexDirection="row" alignItems="center">
                  <Text color={active ? "green" : "cyan"} bold={active}>
                    {active ? "▸ " : "  "}
                    ➕ {row.label}
                  </Text>
                  <Text dimColor> (Press &apos;a&apos; or ↵ to add reviewer wizard)</Text>
                </Box>
              );
            }
            if (row.kind === "member") {
              const reviewer = config.reviewers[row.index];
              const pIcon = reviewer ? providerIcon(reviewer.provider) : "✦";
              return (
                <Box key={`member-${row.index}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                    <Text color={active ? "green" : undefined} bold={active}>
                      {active ? "▸ " : "  "}
                      {pIcon} {row.label}
                    </Text>
                    {active ? (
                      <Text color="red" bold>
                        [Press &apos;d&apos; to Remove]
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              );
            }
            if (row.kind === "strategy") {
              return (
                <Box key="strategy" marginY={0}>
                  <CycleSelector
                    label="Review Strategy"
                    value={config.routing.reviewStrategy}
                    active={active}
                    badge={config.routing.reviewStrategy}
                    badgeTone="ok"
                    description="How many reviewers to summon: Adaptive (Auto) | Single | Panel | Full"
                  />
                </Box>
              );
            }
            if (row.kind === "rounds") {
              return (
                <Box key="rounds" marginY={0}>
                  <CycleSelector
                    label="Max Review Rounds"
                    value={`${config.limits.maxRounds} rounds`}
                    active={active}
                    badge={`${config.limits.maxRounds} max`}
                    badgeTone="info"
                    description="Iteration round cap before stopping or requesting human assistance"
                  />
                </Box>
              );
            }
            if (row.kind === "save") {
              return (
                <Box key="save" marginTop={0} flexDirection="row" alignItems="center">
                  <Text color={active ? "green" : undefined} bold={active}>
                    {active ? "▸ " : "  "}
                    💾 {row.label}
                  </Text>
                  <Text dimColor> (Press ↵ or &apos;s&apos;)</Text>
                </Box>
              );
            }
            return null;
          })}
        </Box>

        <Card title="💡 Mix and Match Reviewer Backends" tone="neutral">
          <Text dimColor>
            Combine cloud API keys (e.g. Gemini via secret) with local CLIs (e.g. Claude via local command)
            for high-speed, cost-effective cross-model review.
          </Text>
        </Card>
      </Box>
    );
  }

  if (section === "ai" || section === "advanced") {
    const fields =
      section === "ai"
        ? buildAiStructuredFields(config, { installedIds })
        : buildAdvancedStructuredFields(config);
    const title = section === "ai" ? "🤖 AI Defaults & Model Selection" : "⚙ Advanced Routing & Budgets";
    const hint =
      section === "ai"
        ? "Configure execution mode, code author, and default models"
        : "Tune model routing strategies, rounds limit, and message thresholds";

    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            {title}
          </Text>
          <Text dimColor>
            <Text color="cyan" bold>← →</Text> Cycle value · <Text color="green" bold>s</Text> Save · <Text color="yellow" bold>Esc</Text> Back
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={focused ? "green" : "gray"}
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          {fields.map((field, index) => {
            const active = index === selected;
            if (field.isAction) {
              return (
                <Box key={field.label} marginTop={0} flexDirection="row" alignItems="center">
                  <Text color={active ? "green" : undefined} bold={active}>
                    {active ? "▸ " : "  "}
                    💾 {field.label}
                  </Text>
                  <Text dimColor> ({field.value})</Text>
                </Box>
              );
            }

            return (
              <Box key={field.label} marginY={0}>
                <CycleSelector
                  label={field.label}
                  value={field.value}
                  active={active}
                  badge={field.badge}
                  badgeTone={field.badgeTone}
                  description={field.description}
                />
              </Box>
            );
          })}
        </Box>

        <Card title="ℹ Configuration Guide" tone="neutral">
          <Text dimColor>{hint}</Text>
        </Card>
      </Box>
    );
  }

  if (section === "keys") {
    const envLine =
      envHints.length > 0
        ? `Detected environment keys: ${envHints.map((h) => `$${h.envName}`).join(", ")}`
        : null;

    if (keys.length === 0) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text bold color="white">
              🔑 API Keys Vault (Encrypted Storage)
            </Text>
            <Text dimColor>
              <Text color="green" bold>a</Text> Add Key · <Text color="yellow" bold>Esc</Text> Back
            </Text>
          </Box>

          <Card title="No API Keys in Vault" tone="warn">
            <Text dimColor>
              Keys stored here unlock Gemini, OpenAI, OpenRouter, and Qwen.
              They are safely encrypted on your machine in ~/.assentor/
            </Text>
            {envLine ? (
              <Box marginTop={1}>
                <Text color="cyan">{envLine}</Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color="green" bold>
                Press &quot;a&quot; to add your first API key!
              </Text>
            </Box>
          </Card>
        </Box>
      );
    }

    const items: ScrollListItem[] = [
      { id: "add", icon: "➕", label: "Add new API key…" },
      ...keys.map((k) => ({
        id: k.id,
        icon: "✦",
        label: `${k.name} (${k.provider})  ${k.masked}`,
        badge: k.health,
        badgeTone: (k.health === "healthy" ? "ok" : k.health === "failed" ? "error" : "warn") as "ok" | "error" | "warn",
        description: k.enabled ? "Enabled for review & orchestrator" : "Disabled",
      })),
    ];

    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            🔑 API Keys Vault ({keys.length} keys)
          </Text>
          <Text dimColor>
            <Text color="green" bold>a</Text> Add · <Text color="cyan" bold>c</Text> Test · <Text color="yellow" bold>C</Text> Test All · <Text color="red" bold>d</Text> Delete · <Text color="yellow" bold>Esc</Text> Back
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={focused ? "green" : "gray"}
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <ScrollList
            items={items}
            selected={selected}
            focused={focused}
            maxVisible={6}
          />
        </Box>

        {envLine ? (
          <Box marginLeft={1}>
            <Text dimColor>{envLine}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (section === "executors") {
    const rows: ExecutorRow[] = executorRows.filter(
      (r) => r.detection?.installed ?? true,
    );

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="white">
              💻 Executors Detection Hub
            </Text>
          </Box>
          <Card title="No Coding Agent CLIs Found" tone="warn">
            <Text dimColor>
              No supported coding agent CLIs (Cursor, Antigravity, Claude Code, etc.) were found on PATH.
            </Text>
            <Box marginTop={1}>
              <Text color="cyan">Press <Text color="green" bold>r</Text> to re-scan PATH, or <Text color="yellow" bold>Esc</Text> to go back.</Text>
            </Box>
          </Card>
        </Box>
      );
    }

    const items: ScrollListItem[] = rows.map((r) => {
      const installed = r.detection?.installed;
      const isCurrent = config.executor.provider === r.id;
      const pathStr = installed ? r.detection?.path ?? "installed" : r.detection?.error ?? "not installed";
      return {
        id: r.id,
        icon: installed ? "✔" : "✖",
        label: `${r.name}${isCurrent ? " ★ (Current Active)" : ""}`,
        badge: installed ? "Installed" : "Missing",
        badgeTone: installed ? "ok" : "error",
        description: pathStr,
      };
    });

    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            💻 Executors Hub ({rows.length} detected)
          </Text>
          <Text dimColor>
            <Text color="green" bold>u</Text> Use as executor · <Text color="cyan" bold>r</Text> Detect all · <Text color="yellow" bold>i</Text> Install plan · <Text color="yellow" bold>Esc</Text> Back
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={focused ? "green" : "gray"}
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <ScrollList
            items={items}
            selected={selected}
            focused={focused}
            maxVisible={6}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="white">
          🚀 System Maintenance & Updates
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <ScrollList
          items={[
            { icon: "🔍", label: "Check for updates from GitHub release registry" },
            { icon: "⚡", label: "Update Assentor to latest release" },
            { icon: "🗑", label: "Uninstall Assentor CLI symlink" },
          ]}
          selected={selected}
          focused={focused}
          maxVisible={3}
        />
      </Box>
      <Box flexDirection="row" alignItems="center">
        <Badge label="CAUTION" tone="warn" />
        <Text dimColor>  Uninstall only removes the CLI binary link; your project configs and history are kept safe.</Text>
      </Box>
    </Box>
  );
}
