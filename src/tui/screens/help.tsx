import React from "react";
import { Box, Text } from "ink";

export function HelpScreen() {
  return (
    <Box flexDirection="column">
      <Text bold>Help</Text>
      <Text dimColor>
        Assentor coordinates an executor and reviewers around a Task.
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Primary
        </Text>
        <Text>Workspace — start / continue / review</Text>
        <Text>Tasks — history and resume</Text>
        <Text>Agents — specialty roles (view-only)</Text>
        <Text>Review — explain who would review a goal</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Commands
        </Text>
        <Text>/ or Ctrl+K — command palette</Text>
        <Text>? — contextual help overlay</Text>
        <Text>n — new task · m — Supervised/Autopilot · r/p — explain reviewers · Tasks r resume / d delete</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          CLI
        </Text>
        <Text dimColor>assentor run &quot;goal&quot;</Text>
        <Text dimColor>assentor review &quot;goal&quot;</Text>
        <Text dimColor>assentor resume [task-id]</Text>
        <Text dimColor>assentor diagnostics · assentor keys · assentor reviewers</Text>
      </Box>
    </Box>
  );
}
