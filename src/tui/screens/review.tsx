import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { ComplexityAnalysis } from "../../review/complexity.js";
import { explainReviewPlan } from "../../review/complexity.js";
import { Badge } from "../components/badge.js";
import { ProgressBar } from "../components/progress.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

export const REVIEW_ACTIONS = [
  { id: "plan", label: "Explain & Score Reviewers for a Goal", icon: "🛡", description: "Type any task goal to test offline complexity analyzer" },
  { id: "strategy", label: "Change Review Strategy & Panel Size", icon: "⚙", description: "Switch between Adaptive, Panel, Single, and Full review routing" },
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

  const actionItems: ScrollListItem[] = REVIEW_ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    icon: a.icon,
    description: a.description,
  }));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          🛡 Multi-Agent Review Engine & Complexity Routing
        </Text>
        <Badge
          label={config.routing.reviewStrategy === "ADAPTIVE" ? "Adaptive Auto" : config.routing.reviewStrategy}
          tone="ok"
        />
      </Box>

      {/* Review Actions Menu */}
      <Box
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <ScrollList items={actionItems} selected={selected} focused={focused} maxVisible={2} />
      </Box>

      {/* Complexity Scorer Outcome Card */}
      {explained ? (
        <Card
          title={`🛡 ${explained.headline}`}
          badge={<Badge label={explained.riskLabel} tone={riskTone(plan!.risk)} />}
        >
          <Box flexDirection="column" marginTop={0}>
            <Box flexDirection="row" alignItems="center" marginBottom={1}>
              <Text bold>Complexity Score: </Text>
              <ProgressBar
                value={plan?.score ?? 0}
                max={100}
                width={16}
                tone={plan?.risk === "critical" || plan?.risk === "high" ? "red" : plan?.risk === "medium" ? "yellow" : "green"}
              />
              <Text dimColor> ({plan?.score ?? 0}/100)</Text>
              <Text dimColor>   ·   Depth: </Text>
              <Text color="yellow" bold>{explained.depthLabel}</Text>
            </Box>

            <Box flexDirection="row" marginBottom={0}>
              <Text dimColor>Required Specialties: </Text>
              <Text color="green" bold>{explained.reviewers.join(" · ")}</Text>
            </Box>

            {explained.backends.length > 0 ? (
              <Box flexDirection="row" marginTop={0}>
                <Text dimColor>Active Reviewers: </Text>
                <Text color="cyan" bold>{explained.backends.join(" · ")}</Text>
              </Box>
            ) : explained.backendHint ? (
              <Box marginTop={0}>
                <Text color="yellow">⚠ {explained.backendHint}</Text>
              </Box>
            ) : null}

            {explained.reasons.length > 0 ? (
              <Box marginTop={1} flexDirection="column">
                <Text bold color="white">Detected Complexity Triggers:</Text>
                {explained.reasons.map((reason) => (
                  <Text key={reason} dimColor>
                    • {reason}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        </Card>
      ) : (
        <Card title="⚡ Live Complexity Analysis Ready" tone="neutral">
          <Text dimColor>
            Press <Text color="green" bold>p</Text> to enter any goal prompt. Assentor calculates an offline complexity score
            (no LLM latency) and shows which specialty roles and configured backends will be summoned.
          </Text>
        </Card>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Configured Backends: {config.reviewers.length === 0 ? "None (using mock)" : config.reviewers.map((r) => `${r.provider}/${r.transport ?? "api"}`).join(", ")}
        </Text>
      </Box>
    </Box>
  );
}

function riskTone(risk: string): "ok" | "warn" | "error" | "info" {
  if (risk === "critical" || risk === "high") return "error";
  if (risk === "medium") return "warn";
  return "ok";
}
