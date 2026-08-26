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
  const explained = plan ? explainReviewPlan(plan, config.reviewers) : null;

  return (
    <Box flexDirection="column">
      <Text bold>Review</Text>
      <Text dimColor>
        Reviewers inspect the executor&apos;s work. You add the backends
        (Gemini API, Claude CLI, …) under Configure → Reviewers.
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
            Specialties {explained.reviewers.join(" · ")}
            {"  "}
            <Badge label={explained.riskLabel} tone={riskTone(plan!.risk)} />
          </Text>
          {explained.backends.length > 0 ? (
            <Text dimColor>
              Your reviewers: {explained.backends.join(" · ")}
            </Text>
          ) : explained.backendHint ? (
            <Text color="yellow">{explained.backendHint}</Text>
          ) : null}
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
            Press <Text color="cyan">p</Text> and type a goal. Assentor scores
            it offline (no LLM) and shows which of your reviewers would run,
            plus why specialties like Security were suggested.
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
