import React from "react";
import { Box, Text, useStdout } from "ink";
import { formatRunMode } from "../../core/run-mode.js";
import type { AssentorConfig } from "../../config/load.js";
import type { AssentorServices } from "../../services/app.js";
import type { TaskSnapshot } from "../../persistence/store.js";
import type { UpdateCheckResult } from "../../self/index.js";
import { Badge } from "../components/badge.js";
import { ProgressBar } from "../components/progress.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

export const WORKSPACE_ACTIONS = [
  { id: "start", label: "Start a new task", icon: "▶", description: "Launch coding executor with automated multi-agent review" },
  { id: "continue", label: "Continue latest task", icon: "↺", description: "Resume interrupted, failed, or timed-out task" },
  { id: "review", label: "Explain reviewers for a goal", icon: "🛡", description: "Analyze complexity and role assignments offline" },
  { id: "diagnostics", label: "Run diagnostics", icon: "🩺", description: "Verify CLI tools, API keys, and environment health" },
] as const;

export function WorkspaceScreen({
  services,
  config,
  selected,
  tasks,
  updateInfo,
  keyHealthy,
  keyTotal,
}: {
  services: AssentorServices;
  config: AssentorConfig;
  selected: number;
  tasks: TaskSnapshot[];
  updateInfo: UpdateCheckResult | null;
  keyHealthy: number;
  keyTotal: number;
}) {
  const latest = tasks[0];

  const actionItems: ScrollListItem[] = WORKSPACE_ACTIONS.map((a) => {
    if (a.id === "continue") {
      if (latest) {
        return {
          id: a.id,
          label: `Continue "${truncate(latest.contract.goal, 32)}"`,
          badge: latest.status,
          badgeTone: statusTone(latest.status),
          icon: a.icon,
          description: `Round ${latest.currentRound}/${latest.maxRounds} · ${latest.executor}`,
        };
      }
      return {
        id: a.id,
        label: "Continue latest task (no tasks yet)",
        icon: a.icon,
        description: "Run a task first to enable quick resume",
      };
    }
    return {
      id: a.id,
      label: a.label,
      icon: a.icon,
      description: a.description,
    };
  });

  const { stdout } = useStdout();
  const isNarrow = (stdout?.columns ?? 80) < 100;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="white">
          ⚡ Assentor Control Center
        </Text>
        <Text dimColor>Select an action below or press hotkeys</Text>
      </Box>

      {/* Quick Actions List */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <Box marginBottom={0}>
          <Text bold color="cyan">
            ⚡ Quick Actions
          </Text>
        </Box>
        <ScrollList items={actionItems} selected={selected} focused={true} maxVisible={4} />
      </Box>

      {/* Active Project & Latest Task Card */}
      <Card
        title="📁 Current Project Context"
        badge={
          <Badge
            label={shortPath(services.projectPath)}
            tone="brand"
          />
        }
      >
        {latest ? (
          <Box flexDirection="column" marginTop={0}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text bold color="green">
                {truncate(latest.contract.goal, 45)}
              </Text>
              <Badge
                label={latest.status}
                tone={statusTone(latest.status)}
              />
            </Box>
            <Box flexDirection="row" alignItems="center" marginTop={0}>
              <Text dimColor>Executor: </Text>
              <Text color="yellow" bold>{latest.executor}</Text>
              <Text dimColor>  ·  Progress: </Text>
              <ProgressBar
                value={latest.currentRound}
                max={latest.maxRounds}
                width={10}
                tone="cyan"
                showPercent={false}
              />
              <Text dimColor> ({latest.currentRound}/{latest.maxRounds} rounds)</Text>
            </Box>
          </Box>
        ) : (
          <Box marginTop={0}>
            <Text dimColor>
              No tasks recorded in this directory yet. Press <Text color="green" bold>n</Text> to start one!
            </Text>
          </Box>
        )}
      </Card>

      {/* System Status Metrics Bar */}
      {isNarrow ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text dimColor>Mode: </Text>
              <Text color={config.run.mode === "autopilot" ? "yellow" : "cyan"} bold>
                {formatRunMode(config.run.mode)}
              </Text>
              <Text dimColor> (m)</Text>
            </Text>
            <Text>
              <Text dimColor>Exec: </Text>
              <Text color="green" bold>{config.executor.provider}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text dimColor>Reviewers: </Text>
              <Text color="cyan" bold>
                {config.reviewers.length === 0 ? "none" : `${config.reviewers.length} configured`}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Keys: </Text>
              <Text color={keyHealthy > 0 ? "green" : "yellow"} bold>
                {keyHealthy}/{keyTotal} OK
              </Text>
              {updateInfo?.updateAvailable ? (
                <Text color="yellow" bold> · update</Text>
              ) : null}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          marginTop={1}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Box flexDirection="row">
            <Text dimColor>Mode: </Text>
            <Text color={config.run.mode === "autopilot" ? "yellow" : "cyan"} bold>
              {formatRunMode(config.run.mode)}
            </Text>
            <Text dimColor> (m to toggle)</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Exec: </Text>
            <Text color="green" bold>{config.executor.provider}</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Reviewers: </Text>
            <Text color="cyan" bold>
              {config.reviewers.length === 0 ? "none" : `${config.reviewers.length} configured`}
            </Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Keys: </Text>
            <Text color={keyHealthy > 0 ? "green" : "yellow"} bold>
              {keyHealthy}/{keyTotal} OK
            </Text>
          </Box>
          {updateInfo?.updateAvailable ? (
            <Box flexDirection="row">
              <Badge label={`v${updateInfo.latest} available`} tone="warn" />
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

function statusTone(
  status: string,
): "ok" | "warn" | "error" | "info" | "neutral" {
  if (status === "DONE") return "ok";
  if (
    status.includes("FAIL") ||
    status.includes("BLOCK") ||
    status.includes("HUMAN") ||
    status.includes("TIMEOUT")
  )
    return "error";
  if (status.includes("REVIEW") || status.includes("EXECUT")) return "warn";
  return "info";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
