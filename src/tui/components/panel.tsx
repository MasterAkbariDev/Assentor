import React from "react";
import { Box, Text } from "ink";

export function Panel({
  title,
  children,
  flexGrow,
}: {
  title?: string;
  children: React.ReactNode;
  flexGrow?: number;
}) {
  return (
    <Box
      flexDirection="column"
      flexGrow={flexGrow}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      minHeight={8}
    >
      {title ? (
        <Box marginBottom={0}>
          <Text bold color="cyan">
            {title}
          </Text>
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
