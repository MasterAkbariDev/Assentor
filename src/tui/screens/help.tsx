import React from "react";
import { Box, Text, useStdout } from "ink";
import { Card } from "../components/panel.js";

export function HelpScreen() {
  const { stdout } = useStdout();
  const isNarrow = (stdout?.columns ?? 80) < 90;

  return (
    <Box flexDirection="column">
      <Box marginBottom={0} flexDirection={isNarrow ? "column" : "row"} justifyContent="space-between">
        <Text bold color="white">
          ❓ Keyboard Shortcuts & Help
        </Text>
        <Text dimColor>Esc: nav · q: quit</Text>
      </Box>

      {/* Navigation Card */}
      <Box marginTop={0}>
        <Card title="⚡ Navigation Controls" tone="highlight">
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text><Text color="green" bold>1 – 7</Text> <Text dimColor>Direct Jump</Text></Text>
              <Text dimColor>   ·   </Text>
              <Text><Text color="green" bold>Tab</Text> <Text dimColor>Switch Pane</Text></Text>
            </Box>
            <Box flexDirection="row">
              <Text><Text color="green" bold>↑↓/jk</Text> <Text dimColor>Move Focus</Text></Text>
              <Text dimColor>   ·   </Text>
              <Text><Text color="green" bold>← →</Text> <Text dimColor>Cycle Field</Text></Text>
            </Box>
            <Box flexDirection="row">
              <Text><Text color="green" bold>↵ Enter</Text> <Text dimColor>Select</Text></Text>
              <Text dimColor> ·   </Text>
              <Text><Text color="green" bold>Esc/q</Text> <Text dimColor>Back / Exit</Text></Text>
            </Box>
          </Box>
        </Card>
      </Box>

      {/* Action Keys Card */}
      <Box marginTop={0}>
        <Card title="🎮 Action Shortcuts" tone="highlight">
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text><Text color="yellow" bold>/ ^K</Text> <Text dimColor>Palette</Text></Text>
              <Text dimColor> · </Text>
              <Text><Text color="yellow" bold>n</Text> <Text dimColor>New Task</Text></Text>
              <Text dimColor> · </Text>
              <Text><Text color="yellow" bold>m</Text> <Text dimColor>Mode Toggle</Text></Text>
            </Box>
            <Box flexDirection="row">
              <Text><Text color="yellow" bold>p/r</Text> <Text dimColor>Explain</Text></Text>
              <Text dimColor> · </Text>
              <Text><Text color="yellow" bold>s</Text> <Text dimColor>Save</Text></Text>
              <Text dimColor> · </Text>
              <Text><Text color="yellow" bold>a/d</Text> <Text dimColor>Add/Del</Text></Text>
              <Text dimColor> · </Text>
              <Text><Text color="yellow" bold>c/C</Text> <Text dimColor>Keys</Text></Text>
            </Box>
          </Box>
        </Card>
      </Box>

      {/* CLI Companion Card */}
      <Box marginTop={0}>
        <Card title="💻 CLI Companion Commands" tone="neutral">
          <Box flexDirection="column">
            <Text dimColor><Text color="cyan">assentor run &quot;&lt;goal&gt;&quot;</Text>     — Run supervisor with review</Text>
            <Text dimColor><Text color="cyan">assentor resume [id]</Text>       — Resume task from checkpoint</Text>
            <Text dimColor><Text color="cyan">assentor review &quot;&lt;goal&gt;&quot;</Text>   — Score complexity and team</Text>
            <Text dimColor><Text color="cyan">assentor doctor</Text>            — Preflight diagnostics check</Text>
          </Box>
        </Card>
      </Box>
    </Box>
  );
}
