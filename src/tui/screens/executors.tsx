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
  return (
    <Box flexDirection="column">
      <Text dimColor>[r] re-detect all · [i] show install plan · Enter detect one</Text>
      <MenuList
        focused={focused}
        selected={selected}
        items={rows.map((r) => {
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
      {rows[selected]?.installPlan ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Install:{" "}
            <Badge
              label={rows[selected]!.installPlan!.automatic ? "auto" : "manual"}
              tone="warn"
            />
          </Text>
          <Text color="cyan">{rows[selected]!.installPlan!.command}</Text>
          {rows[selected]!.installPlan!.notes ? (
            <Text dimColor>{rows[selected]!.installPlan!.notes}</Text>
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
