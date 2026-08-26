import React from "react";
import { Box, Text } from "ink";
import { Dialog } from "./dialog.js";
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
          <Text color="cyan">p</Text> Explain reviewers for a goal
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
          CLI: assentor run &quot;…&quot; · assentor resume · assentor diagnostics
        </Text>
      </Box>
    </Dialog>
  );
}

export function StartTaskDialog({
  step,
  projectPath,
  goal,
  explanation,
}: {
  step: "path" | "goal" | "confirm";
  projectPath: string;
  goal: string;
  explanation?: ReviewPlanExplanation | null;
}) {
  return (
    <Dialog
      title="Start a task"
      hint={
        step === "path"
          ? "This is the folder Assentor will work in"
          : step === "goal"
            ? "What should the executor do?"
            : "Enter starts the run in this folder"
      }
    >
      {step === "path" ? (
        <>
          <Text dimColor>Folder (current terminal directory — edit if needed)</Text>
          <Text>
            {projectPath || " "}
            <Text color="green">▌</Text>
          </Text>
        </>
      ) : null}
      {step === "goal" ? (
        <>
          <Text dimColor>
            Folder <Text color="cyan">{projectPath}</Text>
          </Text>
          <Text>
            {goal || " "}
            <Text color="green">▌</Text>
          </Text>
        </>
      ) : null}
      {step === "confirm" ? (
        <Box flexDirection="column">
          <Text>
            Folder <Text color="cyan">{projectPath}</Text>
          </Text>
          <Text>
            Goal <Text color="green">{goal}</Text>
          </Text>
          {explanation ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>{explanation.headline}</Text>
              <Text>{explanation.reviewers.join(" · ")}</Text>
              {explanation.reasons.slice(0, 4).map((reason) => (
                <Text key={reason} dimColor>
                  • {reason}
                </Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>Preparing review…</Text>
          )}
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
      title="Who will review this?"
      hint={capturing ? "Type a goal · Enter explain" : "Enter close"}
    >
      {capturing ? (
        <>
          <Text dimColor>Describe the work in one sentence.</Text>
          <Text>
            {goal || " "}
            <Text color="green">▌</Text>
          </Text>
        </>
      ) : explanation ? (
        <Box flexDirection="column">
          <Text dimColor>{goal}</Text>
          <Text bold>{explanation.headline}</Text>
          <Text>
            {explanation.reviewers.join(" · ")} · {explanation.depthLabel} ·{" "}
            {explanation.riskLabel} risk
          </Text>
          {explanation.reasons.map((reason) => (
            <Text key={reason} dimColor>
              • {reason}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>Analyzing…</Text>
      )}
    </Dialog>
  );
}
