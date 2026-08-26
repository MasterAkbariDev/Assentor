import React from "react";
import { Box, Text } from "ink";

export function LogsScreen({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? (
        <Text dimColor>Press Enter to refresh audit log</Text>
      ) : (
        lines.slice(0, 24).map((line) => <Text key={line}>{line}</Text>)
      )}
    </Box>
  );
}
