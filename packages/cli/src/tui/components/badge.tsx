import React from "react";
import { Text } from "ink";

export type BadgeTone =
  | "neutral"
  | "ok"
  | "warn"
  | "error"
  | "info"
  | "brand"
  | "purple"
  | "blue"
  | "subtle";

const TONE_COLOR: Record<BadgeTone, string | undefined> = {
  neutral: "gray",
  ok: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  brand: "magenta",
  purple: "magenta",
  blue: "blue",
  subtle: "gray",
};

const TONE_ICONS: Partial<Record<BadgeTone, string>> = {
  ok: "✔",
  warn: "▲",
  error: "✖",
  info: "ℹ",
  brand: "◆",
  purple: "✦",
  blue: "●",
};

export function Badge({
  label,
  tone = "neutral",
  icon,
  variant = "pill",
}: {
  label: string;
  tone?: BadgeTone;
  icon?: string;
  variant?: "pill" | "dot" | "solid" | "subtle";
}) {
  const color = TONE_COLOR[tone];
  const iconStr = icon !== undefined ? icon : TONE_ICONS[tone];

  if (variant === "dot") {
    return (
      <Text color={color} bold={tone !== "neutral"}>
        {iconStr ? `${iconStr} ` : "● "}
        {label}
      </Text>
    );
  }

  if (variant === "solid") {
    return (
      <Text
        backgroundColor={color}
        color={tone === "neutral" || tone === "subtle" ? "white" : "black"}
        bold
      >
        {` ${iconStr ? `${iconStr} ` : ""}${label} `}
      </Text>
    );
  }

  if (variant === "subtle") {
    return (
      <Text color={color} dimColor={tone === "neutral" || tone === "subtle"}>
        {iconStr ? `${iconStr} ` : ""}{label}
      </Text>
    );
  }

  // default: pill format [ label ]
  return (
    <Text color={color} bold={tone !== "neutral" && tone !== "subtle"}>
      [{iconStr ? `${iconStr} ` : ""}{label}]
    </Text>
  );
}
