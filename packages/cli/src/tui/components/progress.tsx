import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active = true, intervalMs = 80): string {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return SPINNER_FRAMES[frameIndex] ?? "⠋";
}

export function Spinner({
  label,
  color = "yellow",
}: {
  label?: string;
  color?: string;
}) {
  const frame = useSpinner(true);
  return (
    <Box flexDirection="row" alignItems="center">
      <Text color={color} bold>
        {frame}{" "}
      </Text>
      {label ? <Text color={color}>{label}</Text> : null}
    </Box>
  );
}

export function Progress({
  label,
  active = true,
}: {
  label?: string;
  active?: boolean;
}) {
  const frame = useSpinner(active);
  if (!active) return null;
  return (
    <Box marginY={0}>
      <Text color="yellow" bold>
        {frame} {label ?? "Processing…"}
      </Text>
    </Box>
  );
}

export function ProgressBar({
  value,
  max,
  width = 16,
  tone = "cyan",
  showPercent = true,
  label,
}: {
  value: number;
  max: number;
  width?: number;
  tone?: "cyan" | "green" | "yellow" | "red" | "magenta";
  showPercent?: boolean;
  label?: string;
}) {
  const clampedMax = Math.max(1, max);
  const clampedValue = Math.min(Math.max(0, value), clampedMax);
  const fraction = clampedValue / clampedMax;
  const filled = Math.round(fraction * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  const percent = Math.round(fraction * 100);

  return (
    <Box flexDirection="row" alignItems="center">
      {label ? <Text dimColor>{label} </Text> : null}
      <Text color={tone} bold>
        [{bar}]
      </Text>
      {showPercent ? <Text dimColor> {percent}%</Text> : null}
    </Box>
  );
}
