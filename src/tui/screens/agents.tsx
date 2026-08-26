import React from "react";
import { Box, Text } from "ink";
import type { LogicalAgentProfile } from "../../agents/index.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export function AgentsScreen({
  agents,
  selected,
  focused,
}: {
  agents: LogicalAgentProfile[];
  selected: number;
  focused: boolean;
}) {
  const executors = agents.filter((a) => a.kind === "executor");
  const reviewers = agents.filter(
    (a) => a.kind === "reviewer" || a.kind === "adjudicator",
  );

  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No agents configured</Text>
        <Text dimColor>
          Agents are the people Assentor assigns: an executor that edits code,
          and reviewers that inspect evidence.
        </Text>
        <Text dimColor>
          These are specialty roles (architecture, security, testing) — not the
          Gemini/Claude backends you add. Browse only.
        </Text>
        <Text dimColor>
          Add who actually reviews under Configuration → Reviewers.
        </Text>
      </Box>
    );
  }

  const labels = [
    ...executors.map(
      (a) =>
        `EXEC  ${a.name}  · ${a.executorId ?? a.provider}/${a.model}  ${a.enabled ? "on" : "off"}`,
    ),
    ...reviewers.map(
      (a) =>
        `REV   ${a.name}  · ${(a.specialty ?? "general").padEnd(12)} ${a.provider}/${a.model}  ${a.transport ?? "api"}`,
    ),
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Specialty roles Assentor can assign. Add Gemini/Claude under Configure →
        Reviewers — this list is view-only.
      </Text>
      <Box marginTop={1}>
        <MenuList items={labels} selected={selected} focused={focused} />
      </Box>
      {agents[selected] ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Badge
              label={agents[selected]!.enabled ? "enabled" : "disabled"}
              tone={agents[selected]!.enabled ? "ok" : "warn"}
            />{" "}
            {agents[selected]!.role}
          </Text>
          <Text dimColor>
            {agents[selected]!.instructions.slice(0, 120)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
