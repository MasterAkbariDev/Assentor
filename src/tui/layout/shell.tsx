import React from "react";
import { Box, Text } from "ink";
import { Badge, type BadgeTone } from "../components/badge.js";
import { Progress } from "../components/progress.js";
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

export function StatusBar({
  projectLabel,
  mode,
  executor,
  reviewStrategy,
  model,
  keysHealthy,
  taskLabel,
}: StatusBarProps) {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text dimColor>
        {projectLabel}
        {"  ·  "}
        mode {mode}
        {"  ·  "}
        exec {executor}
        {"  ·  "}
        review {reviewStrategy}
        {"  ·  "}
        model {model}
        {"  ·  "}
        keys {keysHealthy}
        {taskLabel ? `  ·  task ${taskLabel}` : ""}
      </Text>
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
  children: React.ReactNode;
}) {
  const current = NAV_SCREENS.find((s) => s.id === screen);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          ASSENTOR
        </Text>
        <Text dimColor>  v{version}</Text>
        <Text>  </Text>
        <Badge label={statusLabel} tone={statusTone} />
        {statusBar?.mode ? (
          <>
            <Text>  </Text>
            <Badge
              label={statusBar.mode}
              tone={statusBar.mode === "Autopilot" ? "warn" : "info"}
            />
          </>
        ) : null}
        {focus === "main" || focus === "palette" || focus === "dialog" ? (
          <Text color="green"> · focused</Text>
        ) : (
          <Text dimColor> · nav</Text>
        )}
      </Box>

      {statusBar ? <StatusBar {...statusBar} /> : null}

      <Box flexDirection="row" flexGrow={1} marginTop={0}>
        <Box
          flexDirection="column"
          width={20}
          borderStyle="single"
          borderColor={focus === "nav" ? "green" : "gray"}
          paddingX={1}
          marginRight={1}
        >
          {NAV_SCREENS.map((item, index) => {
            const active = index === navIndex;
            const onScreen = item.id === screen;
            return (
              <Text
                key={item.id}
                color={
                  active && focus === "nav"
                    ? "green"
                    : onScreen
                      ? "cyan"
                      : undefined
                }
                bold={active || onScreen}
              >
                {active ? "> " : "  "}
                {item.label}
              </Text>
            );
          })}
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          <Box marginBottom={0}>
            <Text bold color="cyan">
              {(current?.label ?? screen).toUpperCase()}
            </Text>
            {current?.hint ? (
              <Text dimColor>  — {current.hint}</Text>
            ) : null}
          </Box>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={
              focus === "main" || focus === "dialog" || focus === "palette"
                ? "green"
                : "gray"
            }
            paddingX={1}
            flexGrow={1}
            minHeight={14}
          >
            {children}
          </Box>
        </Box>
      </Box>

      {message ? (
        <Box>
          <Text color="yellow">{message}</Text>
        </Box>
      ) : null}
      <Progress active={Boolean(busy)} />
      <Box>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}
