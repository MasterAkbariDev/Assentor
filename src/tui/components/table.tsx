import React from "react";
import { Box, Text } from "ink";

export interface AssentorTableColumn {
  key: string;
  label: string;
  width?: number;
}

export interface AssentorTableProps {
  columns: AssentorTableColumn[];
  rows: Array<Record<string, string>>;
  selected?: number;
  focused?: boolean;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

export function Table({
  columns,
  rows,
  selected = -1,
  focused = false,
}: AssentorTableProps) {
  if (rows.length === 0) {
    return <Text dimColor>(empty)</Text>;
  }

  const widths = columns.map((c: AssentorTableColumn) => {
    const contentMax = Math.max(
      c.label.length,
      ...rows.map((r: Record<string, string>) => (r[c.key] ?? "").length),
    );
    return Math.min(c.width ?? contentMax, Math.max(c.width ?? 8, contentMax));
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {columns
          .map((c: AssentorTableColumn, i: number) => pad(c.label, widths[i]!))
          .join("  ")}
      </Text>
      {rows.map((row: Record<string, string>, index: number) => {
        const active = index === selected;
        const line = columns
          .map((c: AssentorTableColumn, i: number) =>
            pad(row[c.key] ?? "", widths[i]!),
          )
          .join("  ");
        return (
          <Text
            key={`${index}-${line.slice(0, 24)}`}
            color={active && focused ? "green" : active ? "cyan" : undefined}
            bold={active}
          >
            {active ? "> " : "  "}
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
