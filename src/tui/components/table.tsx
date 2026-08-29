import React from "react";
import { Box, Text } from "ink";

export interface AssentorTableColumn {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right" | "center";
}

export interface AssentorTableProps {
  columns: AssentorTableColumn[];
  rows: Array<Record<string, string>>;
  selected?: number;
  focused?: boolean;
  maxVisible?: number;
}

function formatCell(value: string, width: number, align: "left" | "right" | "center" = "left"): string {
  const truncated = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  const padding = width - truncated.length;
  if (padding <= 0) return truncated;
  if (align === "right") return " ".repeat(padding) + truncated;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return " ".repeat(left) + truncated + " ".repeat(right);
  }
  return truncated + " ".repeat(padding);
}

export function Table({
  columns,
  rows,
  selected = -1,
  focused = false,
  maxVisible = 8,
}: AssentorTableProps) {
  if (rows.length === 0) {
    return <Text dimColor>(no data)</Text>;
  }

  const widths = columns.map((c: AssentorTableColumn) => {
    const contentMax = Math.max(
      c.label.length,
      ...rows.map((r: Record<string, string>) => (r[c.key] ?? "").length),
    );
    return Math.min(c.width ?? contentMax, Math.max(c.width ?? 8, contentMax));
  });

  const total = rows.length;
  let startIndex = 0;
  if (total > maxVisible && selected >= 0) {
    const half = Math.floor(maxVisible / 2);
    if (selected <= half) startIndex = 0;
    else if (selected >= total - half) startIndex = total - maxVisible;
    else startIndex = selected - half;
  }
  const endIndex = Math.min(total, startIndex + maxVisible);
  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>   </Text>
        {columns.map((c: AssentorTableColumn, i: number) => (
          <Text key={c.key} bold color="cyan">
            {formatCell(c.label, widths[i]!, c.align)}
            {"  "}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {"─".repeat(widths.reduce((a, b) => a + b + 2, 4))}
      </Text>
      {visibleRows.map((row: Record<string, string>, offset: number) => {
        const index = startIndex + offset;
        const active = index === selected;
        const cursor = active ? (focused ? "▸ " : "› ") : "  ";
        return (
          <Box key={index} flexDirection="row">
            <Text color={active && focused ? "green" : active ? "cyan" : "gray"}>
              {cursor}
            </Text>
            {columns.map((c: AssentorTableColumn, i: number) => (
              <Text
                key={c.key}
                color={active && focused ? "green" : active ? "cyan" : undefined}
                bold={active}
              >
                {formatCell(row[c.key] ?? "", widths[i]!, c.align)}
                {"  "}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
