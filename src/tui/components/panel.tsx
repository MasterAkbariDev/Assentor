import React from "react";
import { Box, Text } from "ink";

export function Panel({
  title,
  subtitle,
  children,
  flexGrow,
  focused = false,
  borderColor,
  paddingX = 1,
  paddingY = 0,
  minHeight,
  width,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  flexGrow?: number;
  focused?: boolean;
  borderColor?: string;
  paddingX?: number;
  paddingY?: number;
  minHeight?: number;
  width?: number | string;
}) {
  const activeBorderColor = borderColor ?? (focused ? "green" : "gray");

  return (
    <Box
      flexDirection="column"
      flexGrow={flexGrow}
      borderStyle="round"
      borderColor={activeBorderColor}
      paddingX={paddingX}
      paddingY={paddingY}
      minHeight={minHeight}
      width={width}
    >
      {title ? (
        <Box marginBottom={0} flexDirection="row" alignItems="center">
          <Text bold color={focused ? "green" : "cyan"}>
            {title}
          </Text>
          {subtitle ? (
            <Text dimColor> — {subtitle}</Text>
          ) : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}

export function Card({
  title,
  badge,
  children,
  focused = false,
  tone = "neutral",
}: {
  title?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  focused?: boolean;
  tone?: "neutral" | "highlight" | "warn" | "error";
}) {
  const borderColor =
    focused
      ? "green"
      : tone === "highlight"
        ? "cyan"
        : tone === "warn"
          ? "yellow"
          : tone === "error"
            ? "red"
            : "gray";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={0}
    >
      {title || badge ? (
        <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
          {title ? (
            <Text bold color={focused ? "green" : "cyan"}>
              {title}
            </Text>
          ) : null}
          {badge}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
