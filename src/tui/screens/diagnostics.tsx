import React from "react";
import { Box, Text } from "ink";

export function DiagnosticsScreen({
  lines,
}: {
  lines: string[];
}) {
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? (
        <Text dimColor>Press Enter to run full diagnostics</Text>
      ) : (
        lines.slice(0, 24).map((line) => <Text key={line}>{line}</Text>)
      )}
    </Box>
  );
}
