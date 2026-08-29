import React from "react";
import { Box, Text } from "ink";
import type { DetectionResult, InstallPlan } from "../../executors/index.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

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
        <Text bold>No executors installed</Text>
        <Text dimColor>
          No supported coding-agent CLIs (Cursor, Antigravity, Claude Code, etc.) were found on PATH.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>[r] re-detect all</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>[r] re-detect all · [u] use as executor · Enter detect one</Text>
      <MenuList
        focused={focused}
        selected={selected}
        items={availableRows.map((r) => {
          const d = r.detection;
          const mark = d
            ? d.installed
              ? "✓"
              : "✗"
            : "?";
          const path = d?.installed ? d.path ?? "" : d?.error ?? "unknown";
          return `${mark} ${r.name} · ${path}`;
        })}
      />
      {availableRows[selected]?.installPlan ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Install:{" "}
            <Badge
              label={availableRows[selected]!.installPlan!.automatic ? "auto" : "manual"}
              tone="warn"
            />
          </Text>
          <Text color="cyan">{availableRows[selected]!.installPlan!.command}</Text>
          {availableRows[selected]!.installPlan!.notes ? (
            <Text dimColor>{availableRows[selected]!.installPlan!.notes}</Text>
          ) : null}
        </Box>
      ) : null}
      {detail ? (
        <Box marginTop={1}>
          <Text color="yellow">{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
