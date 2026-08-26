import React from "react";
import { Box, Text } from "ink";
import type { TaskSnapshot } from "../../persistence/store.js";
import { isFailedResumeStatus } from "../../orchestrator/state-machine.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export function TasksScreen({
  tasks,
  selected,
  focused,
  selectedTaskId,
}: {
  tasks: TaskSnapshot[];
  selected: number;
  focused: boolean;
  selectedTaskId: string | null;
}) {
  if (tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No tasks yet</Text>
        <Text dimColor>
          A task is Assentor&apos;s unit of work — implement, review, fix, pass.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color="cyan">n</Text> or pick &quot;Start a new task&quot;
            from Workspace. CLI: assentor run &quot;…&quot;
          </Text>
        </Box>
      </Box>
    );
  }

  const detail = selectedTaskId
    ? tasks.find((t) => t.taskId === selectedTaskId)
    : undefined;

  if (detail) {
    const canResume = isFailedResumeStatus(detail.status);
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {detail.contract.goal}
        </Text>
        <Text dimColor>id {detail.taskId}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            Status{" "}
            <Badge label={detail.status} tone={tone(detail.status)} />
            {" · "}
            Round {detail.currentRound}/{detail.maxRounds}
          </Text>
          <Text>
            Executor <Text color="green">{detail.executor}</Text>
            {" · "}
            Reviewers {detail.reviewers.join(", ") || "(none)"}
          </Text>
          {detail.reason ? (
            <Text color="yellow">Reason: {detail.reason}</Text>
          ) : null}
          {detail.finalReview ? (
            <Text>
              Last review: {String(detail.finalReview.status)} —{" "}
              {String(
                (detail.finalReview as { summary?: string }).summary ?? "",
              ).slice(0, 80)}
            </Text>
          ) : null}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {canResume ? (
            <Text>
              <Text color="cyan">r</Text> Resume this failed/timed-out task
            </Text>
          ) : (
            <Text dimColor>
              Resume is for FAILED or TIMEOUT tasks only
            </Text>
          )}
          <Text>
            <Text color="cyan">d</Text> Delete this task from history
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc back to list</Text>
        </Box>
      </Box>
    );
  }

  const labels = tasks.map((t) => {
    const mark =
      t.status === "DONE"
        ? "✓"
        : t.status.includes("FAIL") ||
            t.status.includes("HUMAN") ||
            t.status === "TIMEOUT"
          ? "✗"
          : "●";
    const resume = isFailedResumeStatus(t.status) ? "  [resume]" : "";
    return `${mark} ${t.contract.goal.slice(0, 36)}  · ${t.status} · ${t.currentRound}/${t.maxRounds}${resume}`;
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Select a task · <Text color="cyan">n</Text> new ·{" "}
        <Text color="cyan">r</Text> resume failed ·{" "}
        <Text color="cyan">d</Text> delete
      </Text>
      <Box marginTop={1}>
        <MenuList items={labels} selected={selected} focused={focused} />
      </Box>
    </Box>
  );
}

function tone(status: string): "ok" | "warn" | "error" | "info" {
  if (status === "DONE") return "ok";
  if (
    status.includes("FAIL") ||
    status.includes("HUMAN") ||
    status.includes("BLOCK") ||
    status === "TIMEOUT"
  )
    return "error";
  return "warn";
}
