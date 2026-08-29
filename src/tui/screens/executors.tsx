import React from "react";
import { Box, Text } from "ink";
import type { DetectionResult, InstallPlan } from "../../executors/index.js";
import { Badge } from "../components/badge.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

export interface ExecutorRow {
  id: string;
  name: string;
  detection?: DetectionResult;
  installPlan?: InstallPlan;
}

export function ExecutorsScreen({
  rows,
  selected,
  focused,
  detail,
}: {
  rows: ExecutorRow[];
  selected: number;
  focused: boolean;
  detail?: string;
}) {
  const availableRows = rows.filter((r) => r.detection?.installed ?? true);

  if (availableRows.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="white">
            💻 Executors Detection Hub
          </Text>
        </Box>
        <Card title="No Executors Detected" tone="warn">
          <Text dimColor>
            No supported coding-agent CLIs (Cursor, Antigravity, Claude Code, etc.) were found on PATH.
          </Text>
          <Box marginTop={1}>
            <Text color="cyan">Press <Text color="green" bold>r</Text> to re-scan PATH.</Text>
          </Box>
        </Card>
      </Box>
    );
  }

  const selectedRow = availableRows[selected];

  const items: ScrollListItem[] = availableRows.map((r) => {
    const d = r.detection;
    const installed = d?.installed ?? false;
    const icon = installed ? "✔" : "✖";
    const pathStr = installed ? d?.path ?? "installed" : d?.error ?? "unknown";

    return {
      id: r.id,
      icon,
      label: r.name,
      badge: installed ? "Installed" : "Missing",
      badgeTone: installed ? "ok" : "error",
      description: pathStr,
    };
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          💻 Coding Agent Executors Hub ({availableRows.length} checked)
        </Text>
        <Text dimColor>
          <Text color="green" bold>u</Text> Use · <Text color="cyan" bold>r</Text> Detect all · <Text color="yellow" bold>i</Text> Install plan · <Text color="green" bold>↵</Text> Test
        </Text>
      </Box>

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
          maxVisible={5}
        />
      </Box>

      {selectedRow?.installPlan ? (
        <Card
          title={`🚀 Install Plan for ${selectedRow.name}`}
          badge={
            <Badge
              label={selectedRow.installPlan.automatic ? "Automated" : "Manual"}
              tone="warn"
            />
          }
        >
          <Box flexDirection="column" marginTop={0}>
            <Text dimColor>Run Command:</Text>
            <Box borderStyle="single" borderColor="cyan" paddingX={1} marginY={0}>
              <Text color="cyan" bold>{selectedRow.installPlan.command}</Text>
            </Box>
            {selectedRow.installPlan.notes ? (
              <Box marginTop={0}>
                <Text dimColor>{selectedRow.installPlan.notes}</Text>
              </Box>
            ) : null}
          </Box>
        </Card>
      ) : null}

      {detail ? (
        <Box marginTop={1}>
          <Text color="yellow">{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
