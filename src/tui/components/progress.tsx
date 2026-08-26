import React from "react";
import { Box, Text } from "ink";

export function Progress({
  label,
  active = true,
}: {
  label?: string;
  active?: boolean;
}) {
  if (!active) return null;
  return (
    <Box>
      <Text color="cyan">{label ?? "Working…"}</Text>
    </Box>
  );
}
