import React from "react";
import { Box, Text } from "ink";

export function MenuList({
  items,
  selected,
  focused = true,
}: {
  items: string[];
  selected: number;
  focused?: boolean;
}) {
  if (items.length === 0) {
    return <Text dimColor>(empty)</Text>;
  }
  return (
    <Box flexDirection="column">
      {items.map((label, index) => (
        <Text
          key={`${index}-${label.slice(0, 40)}`}
          color={
            index === selected && focused
              ? "green"
              : index === selected
                ? "cyan"
                : undefined
          }
          bold={index === selected}
        >
          {index === selected ? "> " : "  "}
          {label}
        </Text>
      ))}
    </Box>
  );
}

export function maskPreview(secret: string): string {
  if (!secret) return "(empty)";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}

export function cycle<T>(values: readonly T[], current: T, dir: 1 | -1): T {
  const idx = Math.max(0, values.indexOf(current));
  const next = (idx + dir + values.length) % values.length;
  return values[next]!;
}
