import React from "react";
import { Box, Text, useStdout } from "ink";
import { Badge, type BadgeTone } from "../components/badge.js";
import { Spinner } from "../components/progress.js";
import { NAV_SCREENS, type FocusPane, type ScreenId } from "../keymap.js";

export interface StatusBarProps {
  projectLabel: string;
  mode: string;
  executor: string;
  reviewStrategy: string;
  model: string;
  keysHealthy: string;
  taskLabel?: string;
}

const SCREEN_ICONS: Record<ScreenId, string> = {
  workspace: "⚡",
  tasks: "📋",
  agents: "🤖",
  review: "🛡",
  configuration: "⚙",
  diagnostics: "🩺",
  help: "❓",
};

const COMPACT_NAV_LABELS: Record<ScreenId, string> = {
  workspace: "Work",
  tasks: "Tasks",
  agents: "Agents",
  review: "Review",
  configuration: "Config",
  diagnostics: "Diag",
  help: "Help",
};

export function StatusBar({
  projectLabel,
  mode,
  executor,
  reviewStrategy,
  model,
  keysHealthy,
  taskLabel,
}: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const isNarrow = columns < 90;

  const shortModel = model.length > 14 ? `${model.slice(0, 13)}…` : model;
  const shortProj = projectLabel.length > 18 ? `${projectLabel.slice(0, 17)}…` : projectLabel;

  if (isNarrow) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        marginY={0}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="cyan" bold>📁 {shortProj}</Text>
            <Text dimColor> · </Text>
            <Text color={mode === "Autopilot" ? "yellow" : "cyan"} bold>{mode}</Text>
            <Text dimColor> · </Text>
            <Text color="green" bold>{executor}</Text>
          </Text>
          <Text color="cyan">{reviewStrategy}</Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="yellow">{shortModel}</Text>
            <Text dimColor> · </Text>
            <Text color="green" bold>keys {keysHealthy}</Text>
          </Text>
          {taskLabel ? (
            <Text color="white" dimColor>
              {taskLabel.length > 16 ? `${taskLabel.slice(0, 15)}…` : taskLabel}
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginY={0}
    >
      <Box flexDirection="row">
        <Text color="cyan" bold>📁 {shortProj}</Text>
        <Text dimColor> · </Text>
        <Text color={mode === "Autopilot" ? "yellow" : "cyan"} bold>{mode}</Text>
        <Text dimColor> · </Text>
        <Text color="green" bold>{executor}</Text>
        <Text dimColor> · </Text>
        <Text color="cyan">{reviewStrategy}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="yellow">{shortModel}</Text>
        <Text dimColor> · </Text>
        <Text color="green" bold>keys {keysHealthy}</Text>
        {taskLabel ? (
          <>
            <Text dimColor> · </Text>
            <Text color="white">{taskLabel.length > 16 ? `${taskLabel.slice(0, 15)}…` : taskLabel}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

export function Shell({
  version,
  screen,
  focus,
  navIndex,
  statusLabel,
  statusTone = "info",
  message,
  busy,
  footer,
  statusBar,
  children,
}: {
  version: string;
  screen: ScreenId;
  focus: FocusPane;
  navIndex: number;
  statusLabel: string;
  statusTone?: BadgeTone;
  message?: string;
  busy?: boolean;
  footer: string;
  statusBar?: StatusBarProps;
  children?: React.ReactNode;
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const isNarrow = columns < 90;

  const current = NAV_SCREENS.find((s) => s.id === screen);
  const isNavFocused = focus === "nav";
  const navWidth = isNarrow ? 17 : 22;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Top Header Banner */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={0}>
        <Box flexDirection="row" alignItems="center">
          <Text color="cyan" bold>
            ⬡ ASSENTOR
          </Text>
          <Text dimColor> v{version}</Text>
          <Text>  </Text>
          {busy ? (
            <Spinner label="Busy" color="yellow" />
          ) : (
            <Badge label={statusLabel.toUpperCase()} tone={statusTone} />
          )}
          {!isNarrow && statusBar?.mode ? (
            <>
              <Text> </Text>
              <Badge
                label={statusBar.mode.toUpperCase()}
                tone={statusBar.mode === "Autopilot" ? "warn" : "info"}
              />
            </>
          ) : null}
        </Box>

        <Box flexDirection="row" alignItems="center">
          <Text dimColor>Focus: </Text>
          <Text color={isNavFocused ? "yellow" : "green"} bold>
            [{isNavFocused ? "NAV" : "MAIN"}]
          </Text>
          <Text dimColor> (Tab)</Text>
        </Box>
      </Box>

      {/* Status Bar */}
      {statusBar ? <StatusBar {...statusBar} /> : null}

      {/* Main 2-Column Workspace */}
      <Box flexDirection="row" flexGrow={1} marginTop={0}>
        {/* Left Navigation Sidebar */}
        <Box
          flexDirection="column"
          width={navWidth}
          borderStyle="round"
          borderColor={isNavFocused ? "green" : "gray"}
          paddingX={1}
          marginRight={1}
        >
          <Box marginBottom={0}>
            <Text bold color={isNavFocused ? "green" : "cyan"}>
              {isNarrow ? "NAV" : "NAVIGATION"}
            </Text>
          </Box>
          {NAV_SCREENS.map((item, index) => {
            const isHighlighted = index === navIndex;
            const isOnScreen = item.id === screen;
            const icon = SCREEN_ICONS[item.id] ?? "●";
            const labelText = isNarrow ? (COMPACT_NAV_LABELS[item.id] ?? item.label) : item.label;

            const cursor = isHighlighted ? "▸" : " ";
            const textColor =
              isHighlighted && isNavFocused
                ? "green"
                : isOnScreen
                  ? "cyan"
                  : isHighlighted
                    ? "yellow"
                    : undefined;

            return (
              <Box key={item.id} flexDirection="row" alignItems="center">
                <Text
                  color={textColor}
                  bold={isHighlighted || isOnScreen}
                >
                  {cursor}
                  <Text dimColor>{index + 1} </Text>
                  {icon} {labelText}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right Main Content Pane */}
        <Box flexDirection="column" flexGrow={1}>
          <Box marginBottom={0} flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row" alignItems="center">
              <Text bold color={!isNavFocused ? "green" : "cyan"}>
                {SCREEN_ICONS[screen]} {(current?.label ?? screen).toUpperCase()}
              </Text>
              {!isNarrow && current?.hint ? (
                <Text dimColor> — {current.hint}</Text>
              ) : null}
            </Box>
          </Box>

          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={!isNavFocused ? "green" : "gray"}
            paddingX={1}
            paddingY={0}
            flexGrow={1}
            minHeight={13}
          >
            {children}
          </Box>
        </Box>
      </Box>

      {/* Toast Notification Banner */}
      {message ? (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginY={0}
          flexDirection="row"
          alignItems="center"
        >
          <Text color="yellow" bold>
            ℹ {message}
          </Text>
        </Box>
      ) : null}

      {/* Bottom Shortcuts Footer Bar */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        marginY={0}
      >
        <Text dimColor>{footer}</Text>
        <Box flexDirection="row">
          <Text dimColor>[ </Text>
          <Text color="cyan" bold>/ </Text>
          <Text dimColor>Palette ] [ </Text>
          <Text color="cyan" bold>? </Text>
          <Text dimColor>Help ] [ </Text>
          <Text color="cyan" bold>q </Text>
          <Text dimColor>Quit ]</Text>
        </Box>
      </Box>
    </Box>
  );
}
