import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { ComplexityAnalysis } from "../../review/complexity.js";
import { explainReviewPlan } from "../../review/complexity.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export const REVIEW_ACTIONS = [
  { id: "plan", label: "Explain reviewers for a goal" },
  { id: "strategy", label: "Change how reviewers are chosen" },
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
  const explained = plan ? explainReviewPlan(plan) : null;

  return (
    <Box flexDirection="column">
      <Text bold>Review</Text>
      <Text dimColor>
        Reviewers inspect the executor&apos;s work. Assentor chooses how many
        from the task — you usually leave this on Auto.
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          Mode{" "}
          <Text color="green">
            {config.routing.reviewStrategy === "ADAPTIVE"
              ? "Auto — pick by task"
              : config.routing.reviewStrategy}
          </Text>
        </Text>
      </Box>

      {explained ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{explained.headline}</Text>
          <Text>
            {explained.reviewers.join(" · ")}
            {"  "}
            <Badge label={explained.riskLabel} tone={riskTone(plan!.risk)} />
          </Text>
          <Text dimColor>Evidence: {explained.depthLabel}</Text>
          {explained.reasons.map((reason) => (
            <Text key={reason} dimColor>
              • {reason}
            </Text>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color="cyan">p</Text> and type a goal to see who would
            review it and why.
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

function riskTone(risk: string): "ok" | "warn" | "error" | "info" {
  if (risk === "critical" || risk === "high") return "error";
  if (risk === "medium") return "warn";
  return "ok";
}
