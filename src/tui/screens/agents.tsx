import React from "react";
import { Box, Text } from "ink";
import type { LogicalAgentProfile } from "../../agents/index.js";
import { Badge } from "../components/badge.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

export function AgentsScreen({
  agents,
  selected,
  focused,
}: {
  agents: LogicalAgentProfile[];
  selected: number;
  focused: boolean;
}) {
  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="white">
            🤖 Specialty Agent Intelligence Matrix
          </Text>
        </Box>
        <Card title="No Agents Configured" tone="neutral">
          <Text dimColor>
            Agents are specialty roles Assentor assigns dynamically during task review cycles.
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              Add backend providers (Gemini, Claude, Cursor) under <Text color="cyan">Configure › Reviewers</Text>.
            </Text>
          </Box>
        </Card>
      </Box>
    );
  }

  const selectedAgent = agents[selected];

  const items: ScrollListItem[] = agents.map((a) => {
    const isExec = a.kind === "executor";
    const icon = isExec ? "💻" : specialtyIcon(a.specialty);
    const kindTag = isExec ? "EXEC" : "REV";
    const spec = a.specialty ? `[${a.specialty}]` : `[${a.kind}]`;

    return {
      id: a.id,
      icon,
      label: `${kindTag}  ${a.name}  ${spec}`,
      badge: a.enabled ? "Active" : "Disabled",
      badgeTone: a.enabled ? "ok" : "neutral",
      description: `Backend: ${a.provider}/${a.model} · Transport: ${a.transport ?? "api"}`,
    };
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          🤖 Specialty Agent Roles & Intelligence Matrix
        </Text>
        <Text dimColor>
          Browse logical roles (add backends in <Text color="cyan">Configure › Reviewers</Text>)
        </Text>
      </Box>

      {/* Agents Scrollable List */}
      <Box
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <ScrollList
          items={items}
          selected={selected}
          focused={focused}
          maxVisible={6}
        />
      </Box>

      {/* Selected Agent Inspector Card */}
      {selectedAgent ? (
        <Card
          title={`${specialtyIcon(selectedAgent.specialty)} ${selectedAgent.name} (${selectedAgent.role})`}
          badge={
            <Badge
              label={selectedAgent.enabled ? "Enabled" : "Disabled"}
              tone={selectedAgent.enabled ? "ok" : "warn"}
            />
          }
        >
          <Box flexDirection="column" marginTop={0}>
            <Box flexDirection="row" marginBottom={0}>
              <Text dimColor>Role: </Text>
              <Text color="cyan" bold>{selectedAgent.kind.toUpperCase()}</Text>
              {selectedAgent.specialty ? (
                <>
                  <Text dimColor>   ·   Specialty: </Text>
                  <Text color="green" bold>{selectedAgent.specialty}</Text>
                </>
              ) : null}
              <Text dimColor>   ·   Default Model: </Text>
              <Text color="yellow" bold>{selectedAgent.provider}/{selectedAgent.model}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text bold color="white">Verification Focus & Instructions:</Text>
              <Text dimColor>
                {selectedAgent.instructions.length > 240
                  ? `${selectedAgent.instructions.slice(0, 240)}…`
                  : selectedAgent.instructions}
              </Text>
            </Box>
          </Box>
        </Card>
      ) : null}
    </Box>
  );
}

function specialtyIcon(specialty?: string): string {
  switch (specialty?.toLowerCase()) {
    case "security":
      return "🔒";
    case "testing":
    case "qa":
      return "🧪";
    case "architecture":
      return "🏗";
    case "performance":
      return "⚡";
    case "adjudicator":
      return "⚖";
    default:
      return "🛡";
  }
}
