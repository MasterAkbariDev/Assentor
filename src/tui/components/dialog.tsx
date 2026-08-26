import React from "react";
import { Box, Text } from "ink";

export function Dialog({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={0}
    >
      <Text bold color="yellow">
        {title}
      </Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}
