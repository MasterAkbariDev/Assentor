import React from "react";
import { Box, Text } from "ink";
import { Dialog } from "../components/dialog.js";
import type { PaletteCommand } from "../keymap.js";

export function CommandPalette({
  query,
  commands,
  selected,
}: {
  query: string;
  commands: PaletteCommand[];
  selected: number;
}) {
  return (
    <Dialog title="Commands" hint="Fuzzy match · Enter run · Esc close">
      <Text>
        /{query}
        <Text color="green">▌</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {commands.length === 0 ? (
          <Text dimColor>No matching commands</Text>
        ) : (
          commands.slice(0, 10).map((cmd, index) => (
            <Text
              key={cmd.id}
              color={index === selected ? "green" : undefined}
              bold={index === selected}
            >
              {index === selected ? "> " : "  "}
              {cmd.label}
              <Text dimColor>  /{cmd.id}</Text>
            </Text>
          ))
        )}
      </Box>
    </Dialog>
  );
}

export function HelpOverlay({ screenLabel }: { screenLabel: string }) {
  return (
    <Dialog title={`Help — ${screenLabel}`} hint="Esc close">
      <Text bold>What to do</Text>
      <Text dimColor>
        Assentor is built around Tasks. Start or continue a task, then Review.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">/</Text> or <Text color="cyan">Ctrl+K</Text>{" "}
          Command palette
        </Text>
        <Text>
          <Text color="cyan">?</Text> This help
        </Text>
        <Text>
          <Text color="cyan">n</Text> New task (Workspace/Tasks)
        </Text>
        <Text>
          <Text color="cyan">r</Text> / <Text color="cyan">p</Text> Review plan
        </Text>
        <Text>
          <Text color="cyan">Tab</Text> Nav ↔ Main · <Text color="cyan">q</Text>{" "}
          Back to nav / quit on nav
        </Text>
        <Text>
          <Text color="cyan">j/k</Text> Move (vim-style)
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          CLI: assentor run &quot;…&quot; · assentor review &quot;…&quot; ·
          assentor diagnostics
        </Text>
      </Box>
    </Dialog>
  );
}
