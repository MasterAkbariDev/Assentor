import React from "react";
import { Box, Text } from "ink";
import type { TaskSnapshot } from "../../persistence/store.js";
import { isFailedResumeStatus } from "../../orchestrator/state-machine.js";
import { Badge } from "../components/badge.js";
import { ProgressBar } from "../components/progress.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

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
        <Box marginBottom={1}>
          <Text bold color="white">
            📋 Task History & Operations
          </Text>
        </Box>
        <Card title="No Tasks Found" tone="neutral">
          <Text dimColor>
            A Task is Assentor&apos;s primary unit of work — execute, verify evidence, fix, pass.
          </Text>
          <Box marginTop={1}>
            <Text color="cyan">
              Press <Text bold color="green">n</Text> to start a new task, or run in CLI:
            </Text>
            <Text dimColor>  assentor run &quot;Add new feature&quot;</Text>
          </Box>
        </Card>
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
        <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="white">
            📋 Task Details & Review Summary
          </Text>
          <Badge label={detail.status} tone={tone(detail.status)} />
        </Box>

        <Card
          title={detail.contract.goal}
          badge={<Text dimColor>ID: {detail.taskId.slice(0, 12)}…</Text>}
          focused={true}
        >
          <Box flexDirection="column" marginTop={0}>
            {/* Progress and Rounds */}
            <Box flexDirection="row" alignItems="center" marginBottom={1}>
              <Text bold>Execution Progress: </Text>
              <ProgressBar
                value={detail.currentRound}
                max={detail.maxRounds}
                width={12}
                tone={detail.status === "DONE" ? "green" : "cyan"}
              />
              <Text dimColor> ({detail.currentRound} of {detail.maxRounds} rounds)</Text>
            </Box>

            {/* Executor and Reviewers */}
            <Box flexDirection="row" marginBottom={0}>
              <Text dimColor>Assigned Executor: </Text>
              <Text color="green" bold>{detail.executor}</Text>
              <Text dimColor>   ·   Review Team: </Text>
              <Text color="cyan" bold>
                {detail.reviewers.length > 0 ? detail.reviewers.join(", ") : "None"}
              </Text>
            </Box>

            {/* Failure Reason */}
            {detail.reason ? (
              <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text color="yellow" bold>⚠ Failure Reason: </Text>
                <Text color="yellow">{detail.reason}</Text>
              </Box>
            ) : null}

            {/* Final Review Findings */}
            {detail.finalReview ? (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="cyan">
                  🛡 Final Review Outcome: {String(detail.finalReview.status)}
                </Text>
                {typeof (detail.finalReview as { summary?: string }).summary === "string" ? (
                  <Text dimColor>
                    {(detail.finalReview as { summary?: string }).summary}
                  </Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        </Card>

        {/* Action Controls */}
        <Box
          marginTop={1}
          flexDirection="row"
          justifyContent="space-between"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {canResume ? (
            <Text color="green" bold>
              [ r ] Resume this task
            </Text>
          ) : (
            <Text dimColor>[ r ] Resume (only for failed/timeout tasks)</Text>
          )}
          <Text color="red" bold>
            [ d ] Delete task
          </Text>
          <Text color="cyan" bold>
            [ Esc ] Back to list
          </Text>
        </Box>
      </Box>
    );
  }

  const items: ScrollListItem[] = tasks.map((t) => {
    const isDone = t.status === "DONE";
    const isFail =
      t.status.includes("FAIL") ||
      t.status.includes("HUMAN") ||
      t.status === "TIMEOUT";

    const icon = isDone ? "✔" : isFail ? "✖" : "●";
    const resumeBadge = isFailedResumeStatus(t.status) ? " [r to resume]" : "";

    return {
      id: t.taskId,
      icon,
      label: `${t.contract.goal.slice(0, 36)}${resumeBadge}`,
      badge: `${t.status} (${t.currentRound}/${t.maxRounds})`,
      badgeTone: tone(t.status),
      description: `Exec: ${t.executor} · ID: ${t.taskId.slice(0, 8)}`,
    };
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          📋 Task History ({tasks.length} tasks)
        </Text>
        <Text dimColor>
          <Text color="green" bold>↵</Text> View details · <Text color="yellow" bold>r</Text> Resume · <Text color="red" bold>d</Text> Delete · <Text color="cyan" bold>n</Text> New
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
          maxVisible={7}
        />
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
