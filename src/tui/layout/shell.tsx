import React from "react";
import { Box, Text } from "ink";
import { Badge, type BadgeTone } from "../components/badge.js";
import { Progress } from "../components/progress.js";
import { NAV_SCREENS, type FocusPane, type ScreenId } from "../keymap.js";

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
  children: React.ReactNode;
}) {
  const title = `v${version}`;
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={0}>
      <Box flexDirection="column" marginBottom={0}>
        <Text color="cyan" bold>
          ╭────────────────────────────────────────────────────╮
        </Text>
        <Text color="cyan" bold>
          │ ASSENTOR — {title.padEnd(38)}│
        </Text>
        <Text color="cyan" bold>
          ╰────────────────────────────────────────────────────╯
        </Text>
      </Box>

      <Box flexDirection="row" flexGrow={1}>
        <Box
          flexDirection="column"
          width={18}
          borderStyle="single"
          borderColor={focus === "nav" ? "green" : "gray"}
          paddingX={1}
          marginRight={1}
        >
          <Text bold dimColor={focus !== "nav"}>
            NAV
          </Text>
          {NAV_SCREENS.map((item, index) => {
            const active = index === navIndex;
            const current = item.id === screen;
            return (
              <Text
                key={item.id}
                color={
                  active && focus === "nav"
                    ? "green"
                    : current
                      ? "cyan"
                      : undefined
                }
                bold={active || current}
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
              {screen.toUpperCase()}
            </Text>
            <Text> </Text>
            <Badge label={statusLabel} tone={statusTone} />
            {focus === "main" ? (
              <Text color="green"> · main</Text>
            ) : (
              <Text dimColor> · nav</Text>
            )}
          </Box>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={focus === "main" ? "green" : "gray"}
            paddingX={1}
            flexGrow={1}
            minHeight={12}
          >
            {children}
          </Box>
        </Box>
      </Box>

      {message ? (
        <Box marginTop={0}>
          <Text color="yellow">{message}</Text>
        </Box>
      ) : null}
      <Progress active={Boolean(busy)} />
      <Box marginTop={0}>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}
