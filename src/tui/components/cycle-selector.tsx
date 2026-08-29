import React from "react";
import { Box, Text, useStdout } from "ink";

export function CycleSelector({
  label,
  value,
  active = false,
  description,
  badge,
  badgeTone = "ok",
  compact,
}: {
  label: string;
  value: string;
  active?: boolean;
  description?: string;
  badge?: string;
  badgeTone?: "ok" | "warn" | "error" | "info" | "neutral";
  compact?: boolean;
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const isNarrow = compact ?? (columns < 90);

  const arrowColor = active ? "green" : "gray";
  const valueColor = active ? "green" : "cyan";

  const badgeColor =
    badgeTone === "ok"
      ? "green"
      : badgeTone === "warn"
        ? "yellow"
        : badgeTone === "error"
          ? "red"
          : "cyan";

  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" alignItems="center" justifyContent="space-between">
        <Text color={active ? "green" : undefined} bold={active}>
          {active ? "▸ " : "  "}
          {label}
        </Text>
        <Box flexDirection="row" alignItems="center">
          {badge ? <Text color={badgeColor}>[{badge}] </Text> : null}
          <Text color={arrowColor} bold={active}>
            ◄{" "}
          </Text>
          <Text color={valueColor} bold={active}>
            {value}
          </Text>
          <Text color={arrowColor} bold={active}>
            {" "}►
          </Text>
        </Box>
      </Box>
      {description && !isNarrow ? (
        <Box marginLeft={4}>
          <Text dimColor>{description}</Text>
        </Box>
      ) : description && active ? (
        <Box marginLeft={4}>
          <Text dimColor>{description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
