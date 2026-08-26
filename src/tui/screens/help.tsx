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
        <Text>Agents — who implements & who reviews</Text>
        <Text>Review — complexity plan & strategy</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Commands
        </Text>
        <Text>/ or Ctrl+K — command palette</Text>
        <Text>? — contextual help overlay</Text>
        <Text>n — new task · r/p — review plan</Text>
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
