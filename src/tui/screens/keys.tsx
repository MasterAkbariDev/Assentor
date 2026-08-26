import React from "react";
import { Box, Text } from "ink";
import type { StoredApiKey } from "../../keys/index.js";
import { userSecretsPath } from "../../config/paths.js";
import { Dialog } from "../components/dialog.js";
import { MenuList, maskPreview } from "./shared.js";

export const KEY_PROVIDERS = ["gemini", "openai", "openrouter", "qwen"] as const;

export type AddKeyStep = "provider" | "name" | "secret";

export function KeysScreen({
  keys,
  selected,
  focused,
  dialog,
  addStep,
  addProviderIdx,
  addName,
  addSecret,
}: {
  keys: StoredApiKey[];
  selected: number;
  focused: boolean;
  dialog: "none" | "add-key";
  addStep: AddKeyStep;
  addProviderIdx: number;
  addName: string;
  addSecret: string;
}) {
  const items = [
    "+ Add API key…",
    ...keys.map(
      (k) =>
        `${k.name} (${k.provider}) ${k.masked} · ${k.health}${k.enabled ? "" : " · disabled"}`,
    ),
  ];

  if (dialog === "add-key") {
    return (
      <Dialog title="Add API Key">
        {addStep === "provider" && (
          <>
            <Text>Provider (↑ ↓, then Enter):</Text>
            <MenuList items={[...KEY_PROVIDERS]} selected={selected} focused />
          </>
        )}
        {addStep === "name" && (
          <>
            <Text>
              Label: <Text color="green">{addName || " "}</Text>
              <Text color="gray">█</Text>
            </Text>
            <Text dimColor>Type a name · Enter next · Esc cancel</Text>
          </>
        )}
        {addStep === "secret" && (
          <>
            <Text>
              Provider:{" "}
              <Text color="cyan">{KEY_PROVIDERS[addProviderIdx]}</Text>
              {" · "}
              Name: <Text color="cyan">{addName}</Text>
            </Text>
            <Text>
              API key: <Text color="green">{maskPreview(addSecret)}</Text>
              <Text color="gray">█</Text>
            </Text>
            <Text dimColor>
              Paste key · Enter save · Esc cancel · len={addSecret.length}
            </Text>
          </>
        )}
      </Dialog>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        [a] Add · [c] Check · [C] Check All · [d] Delete
      </Text>
      <MenuList items={items} selected={selected} focused={focused} />
      <Text dimColor>Global keys: {userSecretsPath()}</Text>
    </Box>
  );
}
