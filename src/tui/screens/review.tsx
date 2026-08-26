import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { ComplexityAnalysis } from "../../review/complexity.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export const REVIEW_ACTIONS = [
  { id: "plan", label: "Open review plan (complexity → reviewers)" },
  { id: "cli", label: "Show CLI: assentor review \"…\"" },
  { id: "strategy", label: "Change review strategy (defaults)" },
] as const;

export function ReviewScreen({
  config,
  selected,
  focused,
  plan,
}: {
  config: AssentorConfig;
  selected: number;
  focused: boolean;
  plan: ComplexityAnalysis | null;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Review</Text>
      <Text dimColor>
        Assentor recommends reviewers from task complexity — you rarely pick
        them by hand.
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          Strategy{" "}
          <Text color="green">{config.routing.reviewStrategy}</Text>
          {" · "}
          Routing {config.routing.strategy}
        </Text>
      </Box>

      {plan ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>LAST PLAN</Text>
          <Text>
            Score {plan.score}/100 · risk{" "}
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
            {" · "}
            depth {plan.evidenceDepth}
          </Text>
          <Text>
            Recommended ({plan.recommendedCount}):{" "}
            {plan.recommendedRoles.join(", ")}
          </Text>
          {plan.signals.slice(0, 4).map((s) => (
            <Text key={s} dimColor>
              • {s}
            </Text>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            No plan yet. Press <Text color="cyan">p</Text> or select Open review
            plan.
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <MenuList
          items={REVIEW_ACTIONS.map((a) => a.label)}
          selected={selected}
          focused={focused}
        />
      </Box>
    </Box>
  );
}
