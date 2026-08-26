import React from "react";
import { Box, Text } from "ink";
import type { DiagnosticItem } from "../../services/app.js";
import { Badge } from "../components/badge.js";
import { MenuList } from "./shared.js";

export function DiagnosticsScreen({
  items,
  selected,
  focused,
  busy,
}: {
  items: DiagnosticItem[];
  selected: number;
  focused: boolean;
  busy?: boolean;
}) {
  if (busy) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Checking providers, keys, and executors…</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Diagnostics</Text>
        <Text dimColor>
          Verify executors, AI providers, and API keys — then fix what fails.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color="cyan">Enter</Text> to run checks.
          </Text>
        </Box>
      </Box>
    );
  }

  const failed = items.filter((i) => !i.ok);
  const labels = items.map(
    (i) => `${i.ok ? "✓" : "✗"} ${i.name}  — ${i.detail.slice(0, 50)}`,
  );

  return (
    <Box flexDirection="column">
      <Text>
        <Badge
          label={failed.length === 0 ? "healthy" : `${failed.length} issues`}
          tone={failed.length === 0 ? "ok" : "error"}
        />
        <Text dimColor>  Enter refresh · CLI: assentor diagnostics</Text>
      </Text>
      {failed[0] ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Next step</Text>
          <Text>
            {failed[0].name}: {failed[0].detail}
          </Text>
          <Text dimColor>
            {failed[0].name.startsWith("executor:")
              ? "Open Configure → Executors → install/detect"
              : failed[0].name.startsWith("key:") ||
                  failed[0].name.startsWith("provider:")
                ? "Open Configure → API keys → Add / Check"
                : "See Configure or CLI doctor"}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <MenuList items={labels} selected={selected} focused={focused} />
      </Box>
    </Box>
  );
}
