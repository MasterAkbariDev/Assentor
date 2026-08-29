import React from "react";
import { Box, Text } from "ink";
import type { StoredApiKey } from "../../keys/index.js";
import { userSecretsPath } from "../../config/paths.js";
import { Dialog } from "../components/dialog.js";
import { ScrollList, type ScrollListItem } from "../components/scroll-list.js";
import { maskPreview, providerIcon } from "./shared.js";

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
  const items: ScrollListItem[] = [
    { id: "add", icon: "➕", label: "Add new API key…" },
    ...keys.map((k) => ({
      id: k.id,
      icon: providerIcon(k.provider),
      label: `${k.name} (${k.provider})  ${k.masked}`,
      badge: k.health,
      badgeTone: (k.health === "healthy" ? "ok" : k.health === "failed" ? "error" : "warn") as "ok" | "error" | "warn",
      description: k.enabled ? "Enabled for review & orchestrator" : "Disabled",
    })),
  ];

  if (dialog === "add-key") {
    return (
      <Dialog
        title="Add Encrypted API Key"
        subtitle={
          addStep === "provider"
            ? "Step 1/3: Select Provider"
            : addStep === "name"
              ? "Step 2/3: Name Label"
              : "Step 3/3: Paste Key"
        }
        hint={
          addStep === "provider"
            ? "↑↓ Select · ↵ Next · Esc Cancel"
            : addStep === "name"
              ? "Type a label (e.g. Personal) · ↵ Next · Esc Cancel"
              : "Paste key secret · ↵ Save to Vault · Esc Cancel"
        }
        tone="highlight"
      >
        {addStep === "provider" && (
          <Box flexDirection="column">
            <Text dimColor>Select LLM provider for this key:</Text>
            <Box marginTop={1}>
              <ScrollList
                items={[...KEY_PROVIDERS].map((p) => ({
                  label: `${providerIcon(p)}  ${p.toUpperCase()}`,
                }))}
                selected={selected}
                focused={true}
                maxVisible={4}
              />
            </Box>
          </Box>
        )}

        {addStep === "name" && (
          <Box flexDirection="column">
            <Text dimColor>Provider: <Text color="cyan">{KEY_PROVIDERS[addProviderIdx]}</Text></Text>
            <Text dimColor>Key Label / Alias:</Text>
            <Box
              borderStyle="single"
              borderColor="green"
              paddingX={1}
              marginY={0}
              flexDirection="row"
            >
              <Text color="green" bold>
                {addName || " "}
              </Text>
              <Text color="green">▌</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>e.g. &quot;Personal Work&quot;, &quot;Team Account&quot;</Text>
            </Box>
          </Box>
        )}

        {addStep === "secret" && (
          <Box flexDirection="column">
            <Box flexDirection="row" marginBottom={0}>
              <Text dimColor>Provider: </Text>
              <Text color="cyan">{KEY_PROVIDERS[addProviderIdx]}</Text>
              <Text dimColor>  ·  Label: </Text>
              <Text color="cyan">{addName}</Text>
            </Box>
            <Text dimColor>API Key Secret (Masked):</Text>
            <Box
              borderStyle="single"
              borderColor="green"
              paddingX={1}
              marginY={0}
              flexDirection="row"
            >
              <Text color="green" bold>
                {maskPreview(addSecret)}
              </Text>
              <Text color="green">▌</Text>
            </Box>
            <Box marginTop={1} flexDirection="row" justifyContent="space-between">
              <Text dimColor>Chars: {addSecret.length}</Text>
              <Text color="green" bold>[ ↵ Press Enter to Save ]</Text>
            </Box>
          </Box>
        )}
      </Dialog>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="white">
          🔑 API Keys Vault ({keys.length} keys)
        </Text>
        <Text dimColor>
          <Text color="green" bold>a</Text> Add · <Text color="cyan" bold>c</Text> Test · <Text color="yellow" bold>C</Text> Test All · <Text color="red" bold>d</Text> Delete
        </Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={focused ? "green" : "gray"}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <ScrollList
          items={items}
          selected={selected}
          focused={focused}
          maxVisible={7}
        />
      </Box>

      <Box>
        <Text dimColor>Vault Path: {userSecretsPath()}</Text>
      </Box>
    </Box>
  );
}
