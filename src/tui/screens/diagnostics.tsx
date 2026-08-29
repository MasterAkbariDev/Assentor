import React from "react";
import { Box, Text } from "ink";
import type { DiagnosticItem } from "../../services/app.js";
import { Badge } from "../components/badge.js";
import { ProgressBar, Spinner } from "../components/progress.js";
import { Card } from "../components/panel.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

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
      <Box flexDirection="column" paddingY={2} alignItems="center">
        <Spinner label="Running full system diagnostics & provider checks…" color="yellow" />
        <Box marginTop={1}>
          <Text dimColor>Testing PATH executors, API key vaults, and network endpoints</Text>
        </Box>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="white">
            🩺 Assentor System Doctor & Diagnostics
          </Text>
        </Box>
        <Card title="Run Full Diagnostic Suite" tone="neutral">
          <Text dimColor>
            Assentor will verify all configured agent executors, vault keys, model access, and project integrity.
          </Text>
          <Box marginTop={1}>
            <Text color="green" bold>
              [ ↵ Press Enter to Run All Checks ]
            </Text>
          </Box>
        </Card>
      </Box>
    );
  }

  const passed = items.filter((i) => i.ok);
  const failed = items.filter((i) => !i.ok);
  const allHealthy = failed.length === 0;

  const scrollItems: ScrollListItem[] = items.map((i) => ({
    id: i.name,
    icon: i.ok ? "✔" : "✖",
    label: i.name,
    badge: i.ok ? "PASS" : "FAIL",
    badgeTone: i.ok ? "ok" : "error",
    description: i.detail,
  }));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          🩺 Assentor System Doctor ({passed.length}/{items.length} Passed)
        </Text>
        <Badge
          label={allHealthy ? "100% HEALTHY" : `${failed.length} ISSUES FOUND`}
          tone={allHealthy ? "ok" : "error"}
        />
      </Box>

      {/* Health Meter */}
      <Box
        flexDirection="row"
        alignItems="center"
        borderStyle="round"
        borderColor={allHealthy ? "green" : "yellow"}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>System Health: </Text>
        <ProgressBar
          value={passed.length}
          max={items.length}
          width={18}
          tone={allHealthy ? "green" : "yellow"}
        />
        <Text dimColor>  ·  Press <Text color="green" bold>↵</Text> to re-run</Text>
      </Box>

      {/* Failure Remediation Advice */}
      {failed[0] ? (
        <Card
          title={`⚠ Actionable Remedy for ${failed[0].name}`}
          badge={<Badge label="Action Needed" tone="warn" />}
          tone="warn"
        >
          <Box flexDirection="column" marginTop={0}>
            <Text color="yellow" bold>{failed[0].detail}</Text>
            <Text dimColor>
              {failed[0].name.startsWith("executor:")
                ? "Fix: Open Configure › Executors to view install plan, or add executable to your PATH."
                : failed[0].name.startsWith("key:") || failed[0].name.startsWith("provider:")
                  ? "Fix: Open Configure › API Keys to add a valid API key, or set appropriate environment variable."
                  : "Fix: Check file permissions and network connectivity."}
            </Text>
          </Box>
        </Card>
      ) : null}

      {/* Diagnostics List */}
      <Box
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginTop={failed[0] ? 1 : 0}
        flexDirection="column"
      >
        <ScrollList
          items={scrollItems}
          selected={selected}
          focused={focused}
          maxVisible={6}
        />
      </Box>
    </Box>
  );
}
