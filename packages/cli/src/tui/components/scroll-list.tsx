import React from "react";
import { Box, Text } from "ink";

export interface ScrollListItem {
  id?: string;
  label: string;
  badge?: string;
  badgeTone?: "ok" | "warn" | "error" | "info" | "brand" | "neutral";
  description?: string;
  icon?: string;
}

export function ScrollList({
  items,
  selected,
  focused = true,
  maxVisible = 8,
  emptyText = "(no items)",
}: {
  items: Array<string | ScrollListItem>;
  selected: number;
  focused?: boolean;
  maxVisible?: number;
  emptyText?: string;
}) {
  if (items.length === 0) {
    return <Text dimColor>{emptyText}</Text>;
  }

  // Calculate sliding window for scrolling
  const total = items.length;
  let startIndex = 0;
  if (total > maxVisible) {
    const half = Math.floor(maxVisible / 2);
    if (selected <= half) {
      startIndex = 0;
    } else if (selected >= total - half) {
      startIndex = total - maxVisible;
    } else {
      startIndex = selected - half;
    }
  }
  const endIndex = Math.min(total, startIndex + maxVisible);
  const visibleItems = items.slice(startIndex, endIndex);

  const hasAbove = startIndex > 0;
  const hasBelow = endIndex < total;

  return (
    <Box flexDirection="column">
      {hasAbove ? (
        <Box marginBottom={0}>
          <Text dimColor>  ▲ {startIndex} more above</Text>
        </Box>
      ) : null}

      {visibleItems.map((rawItem, offset) => {
        const index = startIndex + offset;
        const active = index === selected;
        const item: ScrollListItem =
          typeof rawItem === "string" ? { label: rawItem } : rawItem;

        const cursor = active ? (focused ? "▸ " : "› ") : "  ";
        const textColor = active
          ? focused
            ? "green"
            : "cyan"
          : undefined;

        return (
          <Box key={`${index}-${item.label.slice(0, 30)}`} flexDirection="column">
            <Box flexDirection="row" alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" alignItems="center">
                <Text color={textColor} bold={active}>
                  {cursor}
                  {item.icon ? `${item.icon} ` : ""}
                  {item.label}
                </Text>
              </Box>
              {item.badge ? (
                <Text
                  color={
                    item.badgeTone === "ok"
                      ? "green"
                      : item.badgeTone === "warn"
                        ? "yellow"
                        : item.badgeTone === "error"
                          ? "red"
                          : item.badgeTone === "info"
                            ? "cyan"
                            : "gray"
                  }
                  dimColor={!item.badgeTone || item.badgeTone === "neutral"}
                >
                  [{item.badge}]
                </Text>
              ) : null}
            </Box>
            {item.description ? (
              <Box marginLeft={3}>
                <Text dimColor>{item.description}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}

      {hasBelow ? (
        <Box marginTop={0}>
          <Text dimColor>  ▼ {total - endIndex} more below</Text>
        </Box>
      ) : null}
    </Box>
  );
}
