import React from "react";
import { Box, Text } from "ink";
import { formatRunMode } from "../../core/run-mode.js";
import type { AssentorConfig } from "../../config/load.js";
import type { AssentorServices } from "../../services/app.js";
import type { TaskSnapshot } from "../../persistence/store.js";
import type { UpdateCheckResult } from "../../self/index.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export const WORKSPACE_ACTIONS = [
  { id: "start", label: "Start a new task" },
  { id: "continue", label: "Continue latest task" },
  { id: "review", label: "Explain reviewers for a goal" },
  { id: "diagnostics", label: "Run diagnostics" },
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
  const labels = WORKSPACE_ACTIONS.map((a) => {
    if (a.id === "continue" && latest) {
      return `Continue "${truncate(latest.contract.goal, 36)}" (${latest.status})`;
    }
    if (a.id === "continue") {
      return "Continue a task (none yet)";
    }
    return a.label;
  });

  return (
    <Box flexDirection="column">
      <Text bold>What would you like to do?</Text>
      <Box marginTop={1}>
        <MenuList items={labels} selected={selected} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>CURRENT</Text>
        <Text dimColor>────────────────────────────────────────</Text>
        <Text>
          Folder <Text color="cyan">{shortPath(services.projectPath)}</Text>
        </Text>
        {latest ? (
          <>
            <Text>
              <Text color="cyan">{truncate(latest.contract.goal, 48)}</Text>
            </Text>
            <Text>
              Executor <Text color="green">{latest.executor}</Text>
              {" · "}
              Round {latest.currentRound}/{latest.maxRounds}
              {" · "}
              <Badge
                label={latest.status}
                tone={statusTone(latest.status)}
              />
            </Text>
          </>
        ) : (
          <Text dimColor>
            No tasks in this folder yet. Start one to see live status here.
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Mode {formatRunMode(config.run.mode)} · Defaults{" "}
          {config.executor.provider} /{" "}
          {config.reviewers.length === 0
            ? "no reviewers"
            : config.reviewers
                .map((r) => `${r.provider}/${r.transport ?? "api"}`)
                .join(" + ")}{" "}
          / {config.routing.reviewStrategy}
        </Text>
        <Text dimColor>
          Keys {keyHealthy}/{keyTotal} healthy
          {updateInfo?.updateAvailable
            ? ` · update v${updateInfo.latest} available`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}

function statusTone(
  status: string,
): "ok" | "warn" | "error" | "info" | "neutral" {
  if (status === "DONE") return "ok";
  if (status.includes("FAIL") || status.includes("BLOCK") || status.includes("HUMAN") || status.includes("TIMEOUT"))
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
