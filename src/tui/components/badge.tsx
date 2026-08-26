import React from "react";
import { Text } from "ink";

export type BadgeTone =
  | "neutral"
  | "ok"
  | "warn"
  | "error"
  | "info"
  | "brand";

const TONE_COLOR: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  ok: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  brand: "cyan",
};

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: BadgeTone;
}) {
  return (
    <Text color={TONE_COLOR[tone]} bold={tone !== "neutral"}>
      [{label}]
    </Text>
  );
}
