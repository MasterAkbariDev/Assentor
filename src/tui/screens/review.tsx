import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { ComplexityAnalysis } from "../../review/complexity.js";
import { Dialog } from "../components/dialog.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export function ReviewScreen({
  config,
  selected,
  focused,
  dialog,
  plan,
  planTaskPreview,
  liveLines,
}: {
  config: AssentorConfig;
  selected: number;
  focused: boolean;
  dialog: "none" | "review-plan";
  plan: ComplexityAnalysis | null;
  planTaskPreview: string;
  liveLines: string[];
}) {
  const items = [
    `Review strategy:  ${config.routing.reviewStrategy}`,
    `Primary reviewer: ${config.reviewers[0]?.provider ?? "mock"} (${config.reviewers[0]?.transport ?? "api"})`,
    `Routing:          ${config.routing.strategy}`,
    `Max rounds:       ${config.limits.maxRounds}`,
    "Open Review Plan (complexity)…",
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Config + live panel · [p] Review Plan · runs attach status here
      </Text>
      <MenuList items={items} selected={selected} focused={focused} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Live</Text>
        {liveLines.length === 0 ? (
          <Text dimColor>
            No active run. Live reviewer status appears when a task is running.
          </Text>
        ) : (
          liveLines.slice(0, 8).map((line) => <Text key={line}>{line}</Text>)
        )}
      </Box>

      {dialog === "review-plan" && plan ? (
        <Dialog title="Review Plan">
          <Text dimColor>
            Based on: {planTaskPreview.slice(0, 80) || "(sample / defaults)"}
          </Text>
          <Text>
            Score: <Text color="cyan">{plan.score}</Text>
            {" · "}
            Risk:{" "}
            <Badge
              label={plan.risk}
              tone={
                plan.risk === "critical" || plan.risk === "high"
                  ? "error"
                  : plan.risk === "medium"
                    ? "warn"
                    : "ok"
              }
            />
          </Text>
          <Text>
            Reviewers: {plan.recommendedCount} · Roles:{" "}
            {plan.recommendedRoles.join(", ")}
          </Text>
          <Text>
            Evidence depth: <Text color="green">{plan.evidenceDepth}</Text>
          </Text>
          <Text dimColor>Signals: {plan.signals.join(", ") || "none"}</Text>
          <Text dimColor>Esc to close</Text>
        </Dialog>
      ) : null}
    </Box>
  );
}
