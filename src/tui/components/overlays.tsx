import React from "react";
import { Box, Text } from "ink";
import { Dialog } from "./dialog.js";
import { ProgressBar } from "./progress.js";
import type { PaletteCommand } from "../keymap.js";
import type { ReviewPlanExplanation } from "../../review/complexity.js";

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
    <Dialog
      title="Command Palette"
      subtitle={`Type to search (${commands.length} actions)`}
      hint="↑↓ Select · ↵ Run command · Esc Close"
      tone="highlight"
    >
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        marginY={0}
        flexDirection="row"
        alignItems="center"
      >
        <Text color="cyan" bold>
          /{" "}
        </Text>
        <Text color="white" bold>
          {query}
        </Text>
        <Text color="cyan">▌</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {commands.length === 0 ? (
          <Text dimColor>No matching commands found.</Text>
        ) : (
          commands.slice(0, 8).map((cmd, index) => {
            const active = index === selected;
            return (
              <Box
                key={cmd.id}
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
              >
                <Text
                  color={active ? "green" : undefined}
                  bold={active}
                >
                  {active ? "▸ " : "  "}
                  {cmd.label}
                </Text>
                <Text dimColor>[/{cmd.id}]</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Dialog>
  );
}

export function HelpOverlay({ screenLabel }: { screenLabel: string }) {
  return (
    <Dialog
      title={`Help & Shortcuts — ${screenLabel}`}
      hint="Esc Close overlay · ? Toggle help"
      tone="highlight"
    >
      <Box flexDirection="column">
        <Text bold color="cyan">
          Navigation & Controls
        </Text>
        <Box marginLeft={1} flexDirection="column" marginBottom={1}>
          <Text>
            <Text color="green" bold>Tab</Text>  Toggle between Nav Sidebar and Main Pane
          </Text>
          <Text>
            <Text color="green" bold>1 – 7</Text>  Direct jump to any screen immediately
          </Text>
          <Text>
            <Text color="green" bold>↑ / ↓</Text> or <Text color="green" bold>j / k</Text>  Move cursor through items
          </Text>
          <Text>
            <Text color="green" bold>↵ Enter</Text>  Select / open / advance
          </Text>
          <Text>
            <Text color="green" bold>Esc / q</Text>  Back / focus nav (q on nav quits)
          </Text>
        </Box>

        <Text bold color="cyan">
          Global Shortcuts
        </Text>
        <Box marginLeft={1} flexDirection="column" marginBottom={1}>
          <Text>
            <Text color="yellow" bold>/</Text> or <Text color="yellow" bold>Ctrl+K</Text>  Open interactive Command Palette
          </Text>
          <Text>
            <Text color="yellow" bold>n</Text>  Start a new orchestrated task
          </Text>
          <Text>
            <Text color="yellow" bold>m</Text>  Toggle Supervised / Autopilot mode
          </Text>
          <Text>
            <Text color="yellow" bold>p</Text>  Explain and score reviewers for any goal
          </Text>
          <Text>
            <Text color="yellow" bold>s</Text>  Save configuration defaults
          </Text>
        </Box>

        <Text bold color="cyan">
          CLI Quick Commands
        </Text>
        <Box marginLeft={1} flexDirection="column">
          <Text dimColor>assentor run &quot;your goal&quot;   — Run full task cycle</Text>
          <Text dimColor>assentor resume [task-id]    — Resume interrupted/failed task</Text>
          <Text dimColor>assentor diagnostics         — System check & doctor</Text>
        </Box>
      </Box>
    </Dialog>
  );
}

export function StartTaskDialog({
  step,
  projectPath,
  goal,
  mode,
  executor,
  explanation,
}: {
  step: "path" | "goal" | "confirm";
  projectPath: string;
  goal: string;
  mode?: string;
  executor?: string;
  explanation?: ReviewPlanExplanation | null;
}) {
  const stepIndex = step === "path" ? 1 : step === "goal" ? 2 : 3;

  return (
    <Dialog
      title="Start New Task"
      subtitle={`Step ${stepIndex} of 3`}
      hint={
        step === "path"
          ? "Target workspace directory · ↵ Next · Esc Cancel"
          : step === "goal"
            ? "Describe what the agent should implement · ↵ Next · Esc Cancel"
            : "Review launch plan · ↵ START TASK · Esc Cancel"
      }
      tone={step === "confirm" ? "highlight" : "highlight"}
    >
      <Box flexDirection="row" marginBottom={1} alignItems="center">
        <Text color={step === "path" ? "green" : "dim"} bold={step === "path"}>
          [1: Folder]
        </Text>
        <Text dimColor> ➔ </Text>
        <Text color={step === "goal" ? "green" : "dim"} bold={step === "goal"}>
          [2: Goal]
        </Text>
        <Text dimColor> ➔ </Text>
        <Text color={step === "confirm" ? "green" : "dim"} bold={step === "confirm"}>
          [3: Confirm & Launch]
        </Text>
      </Box>

      {step === "path" ? (
        <Box flexDirection="column">
          <Text dimColor>Project Directory:</Text>
          <Box
            borderStyle="single"
            borderColor="green"
            paddingX={1}
            marginY={0}
            flexDirection="row"
          >
            <Text color="cyan" bold>
              {projectPath || " "}
            </Text>
            <Text color="green">▌</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to use this directory, or edit the path.</Text>
          </Box>
        </Box>
      ) : null}

      {step === "goal" ? (
        <Box flexDirection="column">
          <Box marginBottom={0}>
            <Text dimColor>Target Directory: </Text>
            <Text color="cyan">{projectPath}</Text>
          </Box>
          <Text dimColor>Task Goal / Objective:</Text>
          <Box
            borderStyle="single"
            borderColor="green"
            paddingX={1}
            marginY={0}
            flexDirection="row"
          >
            <Text color="green" bold>
              {goal || " "}
            </Text>
            <Text color="green">▌</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>e.g. &quot;Add user authentication with JWT and refresh tokens&quot;</Text>
          </Box>
        </Box>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column">
          <Box
            borderStyle="round"
            borderColor="green"
            paddingX={1}
            marginBottom={1}
            flexDirection="column"
          >
            <Box flexDirection="row">
              <Text bold color="white">Folder:   </Text>
              <Text color="cyan">{projectPath}</Text>
            </Box>
            <Box flexDirection="row">
              <Text bold color="white">Goal:     </Text>
              <Text color="green" bold>{goal}</Text>
            </Box>
            <Box flexDirection="row">
              <Text bold color="white">Executor: </Text>
              <Text color="yellow">{executor ?? "default"}</Text>
              <Text dimColor>  ·  </Text>
              <Text bold color="white">Mode: </Text>
              <Text color={mode === "Autopilot" ? "yellow" : "cyan"}>{mode ?? "Supervised"}</Text>
            </Box>
          </Box>

          {explanation ? (
            <Box flexDirection="column">
              <Text bold color="cyan">
                🛡 Automated Review Plan ({explanation.headline})
              </Text>
              <Box marginLeft={1} flexDirection="column">
                <Text>
                  Specialty Roles: <Text color="green">{explanation.reviewers.join(" · ")}</Text>
                </Text>
                {explanation.backends.length > 0 ? (
                  <Text>
                    Active Reviewers: <Text color="cyan">{explanation.backends.join(" · ")}</Text>
                  </Text>
                ) : explanation.backendHint ? (
                  <Text color="yellow">{explanation.backendHint}</Text>
                ) : null}
                <Text dimColor>Evidence Depth: {explanation.depthLabel}</Text>
              </Box>
            </Box>
          ) : (
            <Text dimColor>Preparing review pipeline…</Text>
          )}

          <Box marginTop={1}>
            <Text color="green" bold>
              [ ↵ Press Enter to Launch Executor ]
            </Text>
          </Box>
        </Box>
      ) : null}
    </Dialog>
  );
}

export function ReviewPlanDialog({
  capturing,
  goal,
  explanation,
}: {
  capturing: boolean;
  goal: string;
  explanation?: ReviewPlanExplanation | null;
}) {
  return (
    <Dialog
      title="Review Complexity & Routing Scorer"
      subtitle="Offline evidence analyzer (no LLM latency)"
      hint={capturing ? "Type goal · ↵ Analyze · Esc Close" : "↵ or Esc to Close"}
      tone="highlight"
    >
      {capturing ? (
        <Box flexDirection="column">
          <Text dimColor>Enter task objective to inspect how reviewers will be assigned:</Text>
          <Box
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            marginY={0}
            flexDirection="row"
          >
            <Text color="green" bold>
              {goal || " "}
            </Text>
            <Text color="cyan">▌</Text>
          </Box>
        </Box>
      ) : explanation ? (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Analyzed Goal:</Text>
            <Text color="green" bold>{goal}</Text>
          </Box>

          <Box
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            flexDirection="column"
            marginBottom={1}
          >
            <Text bold color="cyan">
              {explanation.headline}
            </Text>
            <Box flexDirection="row" marginTop={0}>
              <Text>Risk: </Text>
              <Text
                color={
                  explanation.riskLabel === "High Risk" || explanation.riskLabel === "Critical Risk"
                    ? "red"
                    : explanation.riskLabel === "Medium Risk"
                      ? "yellow"
                      : "green"
                }
                bold
              >
                [{explanation.riskLabel}]
              </Text>
              <Text dimColor>  ·  Evidence Depth: </Text>
              <Text color="yellow">[{explanation.depthLabel}]</Text>
            </Box>
            <Box flexDirection="row" marginTop={0}>
              <Text>Specialty Roles: </Text>
              <Text color="green">{explanation.reviewers.join(" · ")}</Text>
            </Box>
            {explanation.backends.length > 0 ? (
              <Box flexDirection="row" marginTop={0}>
                <Text>Configured Reviewers: </Text>
                <Text color="cyan">{explanation.backends.join(" · ")}</Text>
              </Box>
            ) : explanation.backendHint ? (
              <Text color="yellow">{explanation.backendHint}</Text>
            ) : null}
          </Box>

          {explanation.reasons.length > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>Complexity Signals:</Text>
              {explanation.reasons.map((reason) => (
                <Text key={reason} dimColor>
                  • {reason}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : (
        <Text dimColor>Analyzing complexity signals…</Text>
      )}
    </Dialog>
  );
}

export type AddReviewerStep = "provider" | "transport" | "key";

export function AddReviewerDialog({
  step,
  providers,
  providerIdx,
  transports,
  transportIdx,
  keyLabels,
  keyIdx,
}: {
  step: AddReviewerStep;
  providers: string[];
  providerIdx: number;
  transports: string[];
  transportIdx: number;
  keyLabels: string[];
  keyIdx: number;
}) {
  const items =
    step === "provider"
      ? providers
      : step === "transport"
        ? transports.map((t) => (t === "cli" ? "CLI (Local Binary on PATH)" : "API Key (Cloud Provider)"))
        : keyLabels;

  const selected =
    step === "provider"
      ? providerIdx
      : step === "transport"
        ? transportIdx
        : keyIdx;

  const stepTitle =
    step === "provider"
      ? "Step 1/3: Choose Reviewer Provider"
      : step === "transport"
        ? "Step 2/3: Select Transport Method"
        : "Step 3/3: Choose API Key";

  return (
    <Dialog
      title="Add Reviewer to Panel"
      subtitle={stepTitle}
      hint="↑↓ Select · ↵ Next · Esc Cancel"
      tone="highlight"
    >
      <Text dimColor>
        {step === "provider"
          ? "Gemini & OpenAI run via API. Claude, Cursor, and Antigravity can run via local CLI."
          : step === "transport"
            ? "API uses credentials from vault/env. CLI runs local agent tool."
            : "Select a stored API key or resolve dynamically from environment variables."}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {items.map((label, index) => {
          const active = index === selected;
          return (
            <Text
              key={`${step}-${label}-${index}`}
              color={active ? "green" : undefined}
              bold={active}
            >
              {active ? "▸ " : "  "}
              {label}
            </Text>
          );
        })}
      </Box>
    </Dialog>
  );
}
