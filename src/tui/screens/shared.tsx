import React from "react";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";

export function MenuList({
  items,
  selected,
  focused = true,
  maxVisible = 8,
}: {
  items: Array<string | ScrollListItem>;
  selected: number;
  focused?: boolean;
  maxVisible?: number;
}) {
  return (
    <ScrollList
      items={items}
      selected={selected}
      focused={focused}
      maxVisible={maxVisible}
    />
  );
}

export function maskPreview(secret: string): string {
  if (!secret) return "(empty)";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 16))}${secret.slice(-4)}`;
}

export function cycle<T>(values: readonly T[], current: T, dir: 1 | -1): T {
  const idx = values.indexOf(current);
  const from = idx < 0 ? 0 : idx;
  const next = (from + dir + values.length) % values.length;
  return values[next]!;
}

export function providerIcon(provider: string): string {
  switch (provider.toLowerCase()) {
    case "gemini":
      return "✦";
    case "openai":
      return "❖";
    case "claude":
    case "anthropic":
      return "⚡";
    case "cursor":
      return "⚙";
    case "antigravity":
      return "⬡";
    case "openrouter":
      return "⬢";
    case "qwen":
      return "🔮";
    default:
      return "●";
  }
}
