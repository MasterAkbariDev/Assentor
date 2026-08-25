import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  createAssentorServices,
  runFullDiagnostics,
  type AssentorServices,
} from "../services/app.js";
import {
  loadAssentorConfig,
  saveAssentorConfig,
  type AssentorConfig,
} from "../config/load.js";
import { uninstallAssentor, updateAssentor } from "../self/index.js";

type Screen =
  | "main"
  | "providers"
  | "keys"
  | "add-key"
  | "executors"
  | "agents"
  | "models"
  | "diagnostics"
  | "logs"
  | "settings"
  | "defaults"
  | "confirm-uninstall";

type AddKeyStep = "provider" | "name" | "secret";

const KEY_PROVIDERS = ["gemini", "openai", "openrouter", "qwen"] as const;

const MAIN_ITEMS = [
  { id: "defaults", label: "Defaults (executor / reviewer / models)" },
  { id: "run", label: "Run Task (CLI: assentor run \"...\")" },
  { id: "providers", label: "Providers" },
  { id: "keys", label: "API Keys" },
  { id: "models", label: "Models" },
  { id: "executors", label: "Executors" },
  { id: "agents", label: "Agents" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "logs", label: "Logs / Audit" },
  { id: "settings", label: "Settings" },
  { id: "update", label: "Update Assentor" },
  { id: "uninstall", label: "Uninstall Assentor" },
  { id: "exit", label: "Exit" },
] as const;

const EXECUTOR_OPTIONS = ["mock", "cursor"] as const;
const REVIEWER_OPTIONS = ["mock", "gemini", "openai"] as const;
const ROUTING_OPTIONS = [
  "FREE_FIRST",
  "CHEAPEST",
  "BALANCED",
  "BEST",
  "CUSTOM",
] as const;
const REVIEW_STRATEGY_OPTIONS = [
  "SINGLE",
  "ADAPTIVE",
  "PANEL",
  "FULL",
] as const;
const ROUND_OPTIONS = [4, 6, 8, 10, 12, 16] as const;

function Header({ title }: { title: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        ╭────────────────────────────────────────────╮
      </Text>
      <Text color="cyan" bold>
        │ ASSENTOR — {title.padEnd(30)}│
      </Text>
      <Text color="cyan" bold>
        ╰────────────────────────────────────────────╯
      </Text>
    </Box>
  );
}

function MenuList({
  items,
  selected,
}: {
  items: string[];
  selected: number;
}) {
  return (
    <Box flexDirection="column">
      {items.map((label, index) => (
        <Text
          key={`${index}-${label}`}
          color={index === selected ? "green" : undefined}
          bold={index === selected}
        >
          {index === selected ? "> " : "  "}
          {label}
        </Text>
      ))}
    </Box>
  );
}

function cycle<T>(values: readonly T[], current: T, dir: 1 | -1): T {
  const idx = Math.max(0, values.indexOf(current));
  const next = (idx + dir + values.length) % values.length;
  return values[next]!;
}

function maskPreview(secret: string): string {
  if (!secret) return "(empty)";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}

function App({
  services,
  initialConfig,
}: {
  services: AssentorServices;
  initialConfig: AssentorConfig;
}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("main");
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const [config, setConfig] = useState<AssentorConfig>(initialConfig);
  const [keysVersion, setKeysVersion] = useState(0);

  const [addStep, setAddStep] = useState<AddKeyStep>("provider");
  const [addProviderIdx, setAddProviderIdx] = useState(0);
  const [addName, setAddName] = useState("Personal");
  const [addSecret, setAddSecret] = useState("");

  const providers = useMemo(() => [...services.providers.values()], [services]);
  const keys = useMemo(() => {
    void keysVersion;
    return services.vault.list();
  }, [services, keysVersion]);
  const agents = services.agents.list();
  const models = services.models.list();

  const modelChoices = useMemo(() => {
    const ids = [
      "AUTO",
      ...models.map((m) => m.id),
      "gemini-3.6-flash",
      "gemini-2.5-flash",
      "gpt-4o-mini",
      "gpt-4o",
    ];
    return [...new Set(ids)];
  }, [models]);

  const defaultRows = [
    `Executor:           ${config.executor.provider}`,
    `Reviewer:           ${config.reviewers[0]?.provider ?? "mock"}`,
    `Routing strategy:   ${config.routing.strategy}`,
    `Review strategy:    ${config.routing.reviewStrategy}`,
    `Default model:      ${config.models.default}`,
    `Gemini model:       ${config.models.gemini}`,
    `OpenAI model:       ${config.models.openai}`,
    `Max rounds:         ${config.limits.maxRounds}`,
    "Save defaults to .assentor/config.yaml",
  ];

  const keyMenuItems = [
    "+ Add API key…",
    ...keys.map(
      (k) =>
        `${k.name} (${k.provider}) ${k.masked} · ${k.health}${k.enabled ? "" : " · disabled"}`,
    ),
  ];

  const capturingText =
    screen === "add-key" && (addStep === "name" || addStep === "secret");

  const itemCount = (() => {
    switch (screen) {
      case "main":
        return MAIN_ITEMS.length;
      case "providers":
        return Math.max(providers.length, 1);
      case "keys":
        return keyMenuItems.length;
      case "agents":
        return Math.max(agents.length, 1);
      case "models":
        return Math.max(models.length, 1);
      case "executors":
        return Math.max(services.executors.list().length, 1);
      case "defaults":
        return defaultRows.length;
      case "settings":
        return 2;
      case "confirm-uninstall":
        return 2;
      case "add-key":
        return addStep === "provider" ? KEY_PROVIDERS.length : 1;
      default:
        return 1;
    }
  })();

  useInput((input, key) => {
    if (busy) return;

    if (capturingText) {
      handleTextCapture(input, key);
      return;
    }

    if (input === "q" && screen === "main") {
      exit();
      return;
    }

    if (key.escape) {
      if (screen === "add-key") {
        setScreen("keys");
        setSelected(0);
        setMessage("Cancelled add key");
        return;
      }
      if (screen === "confirm-uninstall") {
        setScreen("main");
        setSelected(MAIN_ITEMS.findIndex((i) => i.id === "uninstall"));
        setMessage("Uninstall cancelled");
        return;
      }
      if (screen === "defaults") {
        setScreen("settings");
        setSelected(0);
      } else {
        setScreen("main");
        setSelected(0);
      }
      setMessage("");
      return;
    }

    if (key.upArrow) {
      setSelected((s) => (s - 1 + itemCount) % itemCount);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % itemCount);
      return;
    }

    if (screen === "defaults" && (key.leftArrow || key.rightArrow)) {
      const dir: 1 | -1 = key.rightArrow ? 1 : -1;
      setConfig((prev) => applyDefaultCycle(prev, selected, dir, modelChoices));
      return;
    }

    if (key.return) {
      void onEnter();
      return;
    }

    if (screen === "keys") {
      if (input === "a") {
        startAddKey();
        return;
      }
      if (input.toLowerCase() === "c") {
        void checkSelectedKey(input === "C");
        return;
      }
      if (input === "d") {
        void deleteSelectedKey();
        return;
      }
    }
  });

  function handleTextCapture(
    input: string,
    key: {
      escape?: boolean;
      return?: boolean;
      backspace?: boolean;
      delete?: boolean;
      ctrl?: boolean;
      meta?: boolean;
    },
  ) {
    if (key.escape) {
      setScreen("keys");
      setSelected(0);
      setMessage("Cancelled add key");
      return;
    }
    if (key.return) {
      void advanceAddKey();
      return;
    }
    if (key.backspace || key.delete) {
      if (addStep === "name") {
        setAddName((v) => v.slice(0, -1));
      } else {
        setAddSecret((v) => v.slice(0, -1));
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (!input) return;
    // Ink may deliver paste as a multi-character string
    if (addStep === "name") {
      setAddName((v) => (v + input).slice(0, 64));
    } else {
      setAddSecret((v) => (v + input).replace(/\s+/g, "").slice(0, 512));
    }
  }

  function startAddKey() {
    setAddStep("provider");
    setAddProviderIdx(0);
    setAddName("Personal");
    setAddSecret("");
    setSelected(0);
    setScreen("add-key");
    setMessage("Pick provider · Enter next · Esc cancel");
  }

  async function advanceAddKey(providerIdx = addProviderIdx) {
    if (addStep === "provider") {
      setAddProviderIdx(providerIdx);
      setAddStep("name");
      setMessage("Type a label for this key, then Enter");
      return;
    }
    if (addStep === "name") {
      if (!addName.trim()) {
        setMessage("Name cannot be empty");
        return;
      }
      setAddStep("secret");
      setMessage("Paste API key, then Enter to save (hidden)");
      return;
    }
    // secret
    const secret = addSecret.trim();
    if (secret.length < 8) {
      setMessage("Key looks too short — paste the full API key");
      return;
    }
    setBusy(true);
    try {
      const provider = KEY_PROVIDERS[providerIdx]!;
      const key = await services.vault.add({
        provider,
        name: addName.trim(),
        secret,
      });
      await services.audit.append(
        "key.changed",
        `Added key ${key.name} for ${provider}`,
        { provider, name: key.name, masked: key.masked },
      );
      setKeysVersion((v) => v + 1);
      setScreen("keys");
      setSelected(0);
      setAddSecret("");
      setMessage(`✓ Saved ${key.name} (${key.masked}) → .assentor/secrets.json`);
    } catch (error) {
      setMessage(
        `Failed to save key: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedKey() {
    // index 0 is "Add…"
    const key = keys[selected - 1];
    if (!key) {
      setMessage("Select a key to delete (not Add)");
      return;
    }
    setBusy(true);
    try {
      await services.vault.remove(key.id);
      await services.audit.append(
        "key.changed",
        `Removed key ${key.name}`,
        { provider: key.provider, name: key.name },
      );
      setKeysVersion((v) => v + 1);
      setSelected(0);
      setMessage(`✓ Removed ${key.name}`);
    } finally {
      setBusy(false);
    }
  }

  async function checkSelectedKey(all: boolean) {
    setBusy(true);
    setMessage(all ? "Checking all keys…" : "Checking key…");
    try {
      if (all) {
        const results = await services.vault.checkAll((id) =>
          services.providers.get(id),
        );
        setKeysVersion((v) => v + 1);
        setMessage(
          results.length
            ? results
                .map(
                  (r) =>
                    `${r.key.name}: ${r.status.valid ? "✓" : "✗"} ${r.status.message}`,
                )
                .join(" | ")
            : "No keys to check",
        );
      } else {
        const key = keys[selected - 1];
        if (!key) {
          setMessage("Select a stored key (or press C for Check All)");
          return;
        }
        const provider = services.providers.get(key.provider);
        if (!provider) {
          setMessage("Unknown provider");
          return;
        }
        const { status } = await services.vault.checkKey(key.id, provider);
        setKeysVersion((v) => v + 1);
        setMessage(
          status.valid
            ? `✓ ${key.name}: valid · auth · reachable · models=${status.modelsAvailable}`
            : `✗ ${key.name}: ${status.message}`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function onEnter() {
    if (screen === "main") {
      const item = MAIN_ITEMS[selected];
      if (!item) return;
      if (item.id === "exit") {
        exit();
        return;
      }
      if (item.id === "run") {
        setMessage(
          `Defaults: executor=${config.executor.provider} reviewer=${config.reviewers[0]?.provider}. Run: assentor run --project . "…"`,
        );
        return;
      }
      if (item.id === "defaults") {
        setScreen("defaults");
        setSelected(0);
        setMessage("← → change value · Enter on Save · Esc back");
        return;
      }
      if (item.id === "update") {
        setBusy(true);
        setMessage("Updating Assentor…");
        try {
          const result = await updateAssentor();
          const tail = result.output.split("\n").slice(-6).join(" · ");
          setMessage(
            result.code === 0
              ? `✓ Updated. ${tail || "Restart assentor to use the new build."}`
              : `✗ Update failed (exit ${result.code}). ${tail}`,
          );
        } finally {
          setBusy(false);
        }
        return;
      }
      if (item.id === "uninstall") {
        setScreen("confirm-uninstall");
        setSelected(0);
        setMessage("Confirm uninstall");
        return;
      }
      if (item.id === "diagnostics") {
        setScreen("diagnostics");
        setBusy(true);
        setMessage("Running full diagnostics…");
        const items = await runFullDiagnostics(services);
        setDiagLines(
          items.map((i) => `${i.ok ? "✓" : "✗"} ${i.name}: ${i.detail}`),
        );
        setMessage("");
        setBusy(false);
        return;
      }
      if (item.id === "logs") {
        setScreen("logs");
        const events = await services.audit.list(30);
        setDiagLines(events.map((e) => `${e.at} ${e.type} ${e.message}`));
        return;
      }
      setScreen(item.id as Screen);
      setSelected(0);
      setMessage("");
      return;
    }

    if (screen === "confirm-uninstall") {
      if (selected === 1) {
        setScreen("main");
        setSelected(MAIN_ITEMS.findIndex((i) => i.id === "uninstall"));
        setMessage("Uninstall cancelled");
        return;
      }
      setBusy(true);
      setMessage("Uninstalling…");
      try {
        const result = await uninstallAssentor({ purge: false });
        const tail = result.output.split("\n").slice(-4).join(" · ");
        if (result.code === 0) {
          setMessage(`✓ ${tail || "Assentor CLI removed."}`);
          setTimeout(() => exit(), 800);
        } else {
          setMessage(`✗ Uninstall failed. ${tail}`);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    if (screen === "settings") {
      if (selected === 0) {
        setScreen("defaults");
        setSelected(0);
        setMessage("← → change value · Enter on Save · Esc back");
      }
      return;
    }

    if (screen === "defaults") {
      if (selected === defaultRows.length - 1) {
        setBusy(true);
        try {
          const saved = await saveAssentorConfig(
            services.projectPath,
            config,
          );
          setMessage(`✓ Saved defaults → ${saved}`);
          await services.audit.append(
            "agent.updated",
            "Updated run defaults from TUI",
            {
              executor: config.executor.provider,
              reviewer: config.reviewers[0]?.provider,
              routing: config.routing.strategy,
            },
          );
        } finally {
          setBusy(false);
        }
        return;
      }
      setConfig((prev) => applyDefaultCycle(prev, selected, 1, modelChoices));
      return;
    }

    if (screen === "keys") {
      if (selected === 0) {
        startAddKey();
        return;
      }
      const key = keys[selected - 1];
      if (key) {
        setMessage(
          `${key.name}: [c] check · [d] delete · Enter again for check`,
        );
        void checkSelectedKey(false);
      }
      return;
    }

    if (screen === "add-key") {
      void advanceAddKey(addStep === "provider" ? selected : addProviderIdx);
      return;
    }

    if (screen === "executors") {
      const adapter = services.executors.list()[selected];
      if (!adapter) return;
      const detection = await adapter.detect();
      const plan = adapter.installPlan?.();
      setMessage(
        detection.installed
          ? `✓ ${adapter.name} at ${detection.path}`
          : `✗ Not installed. ${plan ? `Install: ${plan.command}` : ""}`,
      );
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header title={screen.toUpperCase()} />
      {screen === "main" && (
        <MenuList items={MAIN_ITEMS.map((i) => i.label)} selected={selected} />
      )}
      {screen === "providers" && (
        <MenuList
          items={
            providers.length
              ? providers.map(
                  (p) =>
                    `${p.name} · keys=${services.vault.list(p.id).length} · healthy=${services.vault.list(p.id).filter((k) => k.health === "healthy").length}`,
                )
              : ["(no providers)"]
          }
          selected={selected}
        />
      )}
      {screen === "keys" && (
        <Box flexDirection="column">
          <Text dimColor>
            [a] Add · [c] Check · [C] Check All · [d] Delete · Esc back
          </Text>
          <MenuList items={keyMenuItems} selected={selected} />
          <Text dimColor>
            Keys are encrypted in .assentor/secrets.json for this project.
          </Text>
        </Box>
      )}
      {screen === "add-key" && (
        <Box flexDirection="column">
          {addStep === "provider" && (
            <>
              <Text>Provider (↑ ↓, then Enter):</Text>
              <MenuList items={[...KEY_PROVIDERS]} selected={selected} />
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
                Paste key (Cmd/Ctrl+V) · Enter save · Esc cancel
              </Text>
              <Text dimColor>
                Length: {addSecret.length} · stored encrypted, never printed
              </Text>
            </>
          )}
        </Box>
      )}
      {screen === "models" && (
        <MenuList
          items={
            models.length
              ? models.map(
                  (m) =>
                    `${m.provider}/${m.id} · code=${m.codingScore} · cost=${m.cost} · free=${m.freeTier}`,
                )
              : ["(no models)"]
          }
          selected={selected}
        />
      )}
      {screen === "agents" && (
        <MenuList
          items={
            agents.length
              ? agents.map(
                  (a) =>
                    `${a.name} · ${a.kind} · ${a.provider}/${a.model} · ${a.enabled ? "on" : "off"}`,
                )
              : ["(no agents)"]
          }
          selected={selected}
        />
      )}
      {screen === "executors" && (
        <MenuList
          items={services.executors.list().map((e) => e.name)}
          selected={selected}
        />
      )}
      {screen === "settings" && (
        <Box flexDirection="column">
          <MenuList
            items={[
              "Defaults (executor / reviewer / models)…",
              "Files: .assentor/config.yaml · secrets.json · agents.json",
            ]}
            selected={selected}
          />
          <Text dimColor>
            These defaults apply to `assentor run` in this project.
          </Text>
        </Box>
      )}
      {screen === "defaults" && (
        <Box flexDirection="column">
          <Text dimColor>
            ← → cycle · Enter cycles or Save · Esc back
          </Text>
          <MenuList items={defaultRows} selected={selected} />
          <Box marginTop={1}>
            <Text>After save, run without flags uses these defaults:</Text>
          </Box>
          <Text color="green">
            {`  assentor run --project . "…"   →  ${config.executor.provider} + ${config.reviewers[0]?.provider}`}
          </Text>
        </Box>
      )}
      {screen === "confirm-uninstall" && (
        <Box flexDirection="column">
          <Text>
            Remove the `assentor` command from ~/.local/bin?
          </Text>
          <Text dimColor>
            Project .assentor/ folders (keys, tasks) are kept.
          </Text>
          <Box marginTop={1}>
            <MenuList
              items={["Yes, uninstall CLI", "Cancel"]}
              selected={selected}
            />
          </Box>
        </Box>
      )}
      {(screen === "diagnostics" || screen === "logs") && (
        <Box flexDirection="column">
          {diagLines.slice(0, 20).map((line) => (
            <Text key={line}>{line}</Text>
          ))}
          <Text dimColor>Esc back</Text>
        </Box>
      )}
      {message ? (
        <Box marginTop={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      ) : null}
      {busy ? <Text color="cyan">Working…</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>
          {capturingText
            ? "Type / paste · Enter · Esc cancel"
            : "↑↓ navigate · Enter · Esc back · q quit"}
        </Text>
      </Box>
    </Box>
  );
}

function applyDefaultCycle(
  prev: AssentorConfig,
  row: number,
  dir: 1 | -1,
  modelChoices: string[],
): AssentorConfig {
  const next = structuredClone(prev);
  switch (row) {
    case 0: {
      const current = EXECUTOR_OPTIONS.includes(
        prev.executor.provider as (typeof EXECUTOR_OPTIONS)[number],
      )
        ? (prev.executor.provider as (typeof EXECUTOR_OPTIONS)[number])
        : "mock";
      next.executor.provider = cycle(EXECUTOR_OPTIONS, current, dir);
      break;
    }
    case 1: {
      const current = (prev.reviewers[0]?.provider ??
        "mock") as (typeof REVIEWER_OPTIONS)[number];
      const provider = cycle(REVIEWER_OPTIONS, current, dir);
      next.reviewers = [{ provider, role: "general" }];
      break;
    }
    case 2:
      next.routing.strategy = cycle(
        ROUTING_OPTIONS,
        prev.routing.strategy,
        dir,
      );
      break;
    case 3:
      next.routing.reviewStrategy = cycle(
        REVIEW_STRATEGY_OPTIONS,
        prev.routing.reviewStrategy,
        dir,
      );
      break;
    case 4:
      next.models.default = cycle(modelChoices, prev.models.default, dir);
      break;
    case 5:
      next.models.gemini = cycle(modelChoices, prev.models.gemini, dir);
      break;
    case 6:
      next.models.openai = cycle(modelChoices, prev.models.openai, dir);
      break;
    case 7:
      next.limits.maxRounds = cycle(
        ROUND_OPTIONS,
        prev.limits.maxRounds as (typeof ROUND_OPTIONS)[number],
        dir,
      );
      break;
    default:
      break;
  }
  return next;
}

export async function startTui(projectPath: string): Promise<void> {
  const services = await createAssentorServices(projectPath);
  const initialConfig = await loadAssentorConfig(projectPath);
  render(<App services={services} initialConfig={initialConfig} />);
}
