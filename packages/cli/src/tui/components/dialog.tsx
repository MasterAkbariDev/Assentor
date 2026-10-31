import React from "react";
import { Box, Text } from "ink";

export function Dialog({
  title,
  subtitle,
  hint,
  children,
  tone = "highlight",
  width,
}: {
  title: string;
  subtitle?: string;
  hint?: string;
  children: React.ReactNode;
  tone?: "highlight" | "warn" | "error" | "brand";
  width?: number;
}) {
  const borderColor =
    tone === "warn"
      ? "yellow"
      : tone === "error"
        ? "red"
        : tone === "brand"
          ? "magenta"
          : "cyan";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={2}
      paddingY={1}
      marginY={0}
      width={width}
    >
      <Box flexDirection="row" alignItems="center" marginBottom={0}>
        <Text bold color={borderColor}>
          ◆ {title}
        </Text>
        {subtitle ? <Text dimColor>  {subtitle}</Text> : null}
      </Box>
      {hint ? (
        <Box marginBottom={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : (
        <Box marginBottom={1} />
      )}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}
