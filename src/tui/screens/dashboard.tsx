import React from "react";
import { Box, Text } from "ink";
import type { AssentorConfig } from "../../config/load.js";
import type { AssentorServices } from "../../services/app.js";
import type { UpdateCheckResult } from "../../self/index.js";
import { Badge } from "../components/badge.js";

export function DashboardScreen({
  services,
  config,
  version,
  updateInfo,
  keyCount,
  agentCount,
}: {
  services: AssentorServices;
  config: AssentorConfig;
  version: string;
  updateInfo: UpdateCheckResult | null;
  keyCount: number;
  agentCount: number;
}) {
  return (
    <Box flexDirection="column">
      <Text>
        Workspace: <Text color="cyan">{services.projectPath}</Text>
      </Text>
      <Text>
        Version: <Text color="cyan">v{version}</Text>
        {updateInfo?.updateAvailable ? (
          <Text color="yellow">
            {" "}
            · update v{updateInfo.latest} available
          </Text>
        ) : (
          <Text dimColor> · up to date</Text>
        )}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Executor: <Text color="green">{config.executor.provider}</Text>
          {" · "}
          Reviewer:{" "}
          <Text color="green">{config.reviewers[0]?.provider ?? "mock"}</Text>
          {" · "}
          Strategy: <Text color="green">{config.routing.reviewStrategy}</Text>
        </Text>
        <Text>
          Keys: <Badge label={String(keyCount)} tone="info" />
          {"  "}
          Agents: <Badge label={String(agentCount)} tone="info" />
          {"  "}
          Models:{" "}
          <Badge label={String(services.models.list().length)} tone="info" />
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Run tasks via CLI: assentor run --project . &quot;…&quot;
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Use ← nav / → main · Tab switches focus · q on nav quits
        </Text>
      </Box>
    </Box>
  );
}
