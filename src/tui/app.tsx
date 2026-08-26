import React, { useEffect, useMemo, useState } from "react";
import { useApp, useInput, render } from "ink";
import {
  analyzeReviewPlan,
  checkAllApiKeys,
  checkApiKey,
  createAssentorServices,
  detectExecutor,
  detectExecutors,
  getLocalVersionSync,
  listProjectTasks,
  loadAuditEvents,
  performUninstall,
  performUpdate,
  performUpdateCheck,
  runFullDiagnostics,
  saveGlobalDefaults,
  type AssentorServices,
} from "../services/app.js";
import {
  loadAssentorConfig,
  type AssentorConfig,
} from "../config/load.js";
import { userSecretsPath } from "../config/paths.js";
import type { UpdateCheckResult } from "../self/index.js";
import type { TaskSnapshot } from "../persistence/store.js";
import type { ComplexityAnalysis } from "../review/complexity.js";
import { Shell } from "./layout/shell.js";
import {
  createInitialUiState,
  footerHints,
  mapKeyToAction,
  reduceUi,
  type ScreenId,
  type UiState,
} from "./keymap.js";
import {
  AgentsScreen,
  cycle,
  DashboardScreen,
  DiagnosticsScreen,
  EXECUTOR_OPTIONS,
  ExecutorsScreen,
  type ExecutorRow,
  KeysScreen,
  KEY_PROVIDERS,
  type AddKeyStep,
  LogsScreen,
  ModelsScreen,
  ProvidersScreen,
  ReviewScreen,
  REVIEWER_OPTIONS,
  REVIEW_STRATEGY_OPTIONS,
  ROUND_OPTIONS,
  ROUTING_OPTIONS,
  SettingsScreen,
  buildDefaultRows,
  SystemScreen,
  TasksScreen,
} from "./screens/index.js";

function App({
  services,
  initialConfig,
}: {
  services: AssentorServices;
  initialConfig: AssentorConfig;
}) {
  const { exit } = useApp();
  const localVersion = useMemo(() => getLocalVersionSync(), []);

  const [ui, setUi] = useState<UiState>(() => createInitialUiState());
  const [config, setConfig] = useState<AssentorConfig>(initialConfig);
  const [message, setMessage] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [executorRows, setExecutorRows] = useState<ExecutorRow[]>([]);
  const [executorDetail, setExecutorDetail] = useState("");
  const [reviewPlan, setReviewPlan] = useState<ComplexityAnalysis | null>(null);

  const [addStep, setAddStep] = useState<AddKeyStep>("provider");
  const [addProviderIdx, setAddProviderIdx] = useState(0);
  const [addName, setAddName] = useState("Personal");
  const [addSecret, setAddSecret] = useState("");

  const keys = useMemo(() => {
    void keysVersion;
    return services.vault.list();
  }, [services, keysVersion]);
  const providers = useMemo(() => [...services.providers.values()], [services]);
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

  const mainItemCount = useMemo(() => {
    if (ui.dialog === "add-key") {
      return addStep === "provider" ? KEY_PROVIDERS.length : 1;
    }
    if (ui.dialog === "confirm-uninstall") return 2;
    if (ui.dialog === "defaults") return buildDefaultRows(config).length;
    if (ui.dialog === "review-plan") return 1;
    switch (ui.screen) {
      case "tasks":
        return Math.max(tasks.length, 1);
      case "agents":
        return Math.max(agents.length, 1);
      case "executors":
        return Math.max(executorRows.length || services.executors.list().length, 1);
      case "providers":
        return Math.max(providers.length, 1);
      case "models":
        return Math.max(models.length, 1);
      case "keys":
        return keys.length + 1;
      case "review":
        return 5;
      case "settings":
        return 3;
      case "system":
        return 3;
      case "diagnostics":
      case "logs":
      case "dashboard":
      default:
        return 1;
    }
  }, [
    ui.dialog,
    ui.screen,
    addStep,
    config,
    tasks.length,
    agents.length,
    executorRows.length,
    services.executors,
    providers.length,
    models.length,
    keys.length,
  ]);

  useEffect(() => {
    setUi((s) => ({ ...s, mainItemCount }));
  }, [mainItemCount]);

  useEffect(() => {
    let cancelled = false;
    void performUpdateCheck()
      .then((result) => {
        if (!cancelled) {
          setUpdateInfo(result);
          if (result.updateAvailable) setMessage(result.message);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ui.screen === "executors" && executorRows.length === 0) {
      void refreshExecutors();
    }
    if (ui.screen === "tasks" && tasks.length === 0) {
      void refreshTasks();
    }
  }, [ui.screen]);

  const capturingText =
    ui.dialog === "add-key" && (addStep === "name" || addStep === "secret");

  useInput((input, key) => {
    const event = {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      return: key.return,
      escape: key.escape,
      tab: key.tab,
      backspace: key.backspace,
      delete: key.delete,
      ctrl: key.ctrl,
      meta: key.meta,
    };

    if (capturingText) {
      handleTextCapture(event);
      return;
    }

    const stateForMap: UiState = {
      ...ui,
      capturingText: false,
      mainItemCount,
    };
    const action = mapKeyToAction(stateForMap, event);

    if (action.type === "quit") {
      exit();
      return;
    }

    if (
      action.type === "nav_up" ||
      action.type === "nav_down" ||
      action.type === "main_up" ||
      action.type === "main_down" ||
      action.type === "focus_nav" ||
      action.type === "focus_main" ||
      action.type === "select_nav" ||
      action.type === "keys_add" ||
      action.type === "review_plan"
    ) {
      if (action.type === "select_nav") setMessage("");
      if (action.type === "keys_add") startAddKeyState();
      if (action.type === "review_plan") openReviewPlan();
      setUi((s) => reduceUi({ ...s, mainItemCount }, action));
      return;
    }

    if (action.type === "escape") {
      if (ui.dialog === "add-key") {
        setUi((s) => ({
          ...s,
          dialog: "none",
          capturingText: false,
          focus: "main",
          mainIndex: 0,
        }));
        setMessage("Cancelled add key");
        return;
      }
      if (ui.dialog === "confirm-uninstall") {
        setUi((s) => ({
          ...s,
          dialog: "none",
          focus: "main",
          mainIndex: 1,
        }));
        setMessage("Uninstall cancelled");
        return;
      }
      setUi((s) => reduceUi({ ...s, mainItemCount }, action));
      setMessage("");
      return;
    }

    if (action.type === "cycle_left" || action.type === "cycle_right") {
      const dir: 1 | -1 = action.type === "cycle_right" ? 1 : -1;
      setConfig((prev) =>
        applyDefaultCycle(prev, ui.mainIndex, dir, modelChoices),
      );
      return;
    }

    if (action.type === "keys_check") {
      void runCheckKey(false);
      return;
    }
    if (action.type === "keys_check_all") {
      void runCheckKey(true);
      return;
    }
    if (action.type === "keys_delete") {
      void deleteSelectedKey();
      return;
    }
    if (action.type === "executors_detect") {
      void refreshExecutors();
      return;
    }
    if (action.type === "executors_install") {
      void showInstallPlan();
      return;
    }
    if (action.type === "space") {
      // Space mirrors Enter on most list screens
      void onActivate();
      return;
    }
    if (action.type === "activate") {
      void onActivate();
    }
  });

  function startAddKeyState() {
    setAddStep("provider");
    setAddProviderIdx(0);
    setAddName("Personal");
    setAddSecret("");
    setMessage("Pick provider · Enter next · Esc cancel");
  }

  function openReviewPlan() {
    const sample =
      config.reviewers[0]?.provider === "mock"
        ? "Review architecture and security for auth refactor with tests"
        : `Review using ${config.routing.reviewStrategy} strategy`;
    const plan = analyzeReviewPlan(sample, {
      projectType: "unknown",
      hasTests: true,
    });
    setReviewPlan(plan);
    setMessage("Review Plan open — Esc to close");
  }

  function handleTextCapture(key: {
    input: string;
    escape?: boolean;
    return?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  }) {
    if (key.escape) {
      setUi((s) => ({
        ...s,
        dialog: "none",
        capturingText: false,
        focus: "main",
        mainIndex: 0,
      }));
      setMessage("Cancelled add key");
      return;
    }
    if (key.return) {
      void advanceAddKey();
      return;
    }
    if (key.backspace || key.delete) {
      if (addStep === "name") setAddName((v) => v.slice(0, -1));
      else setAddSecret((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (!key.input) return;
    if (addStep === "name") {
      setAddName((v) => (v + key.input).slice(0, 64));
    } else {
      setAddSecret((v) => (v + key.input).replace(/\s+/g, "").slice(0, 512));
    }
  }

  async function advanceAddKey(providerIdx = addProviderIdx) {
    if (addStep === "provider") {
      setAddProviderIdx(providerIdx);
      setAddStep("name");
      setUi((s) => ({ ...s, capturingText: true, mainIndex: 0 }));
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
    const secret = addSecret.trim();
    if (secret.length < 8) {
      setMessage("Key looks too short — paste the full API key");
      return;
    }
    setUi((s) => ({ ...s, busy: true }));
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
      setUi((s) => ({
        ...s,
        dialog: "none",
        capturingText: false,
        busy: false,
        mainIndex: 0,
      }));
      setAddSecret("");
      setMessage(
        `✓ Saved ${key.name} (${key.masked}) → ${userSecretsPath()} (global)`,
      );
    } catch (error) {
      setMessage(
        `Failed to save key: ${error instanceof Error ? error.message : String(error)}`,
      );
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function deleteSelectedKey() {
    const key = keys[ui.mainIndex - 1];
    if (!key) {
      setMessage("Select a key to delete (not Add)");
      return;
    }
    setUi((s) => ({ ...s, busy: true }));
    try {
      await services.vault.remove(key.id);
      await services.audit.append("key.changed", `Removed key ${key.name}`, {
        provider: key.provider,
        name: key.name,
      });
      setKeysVersion((v) => v + 1);
      setUi((s) => ({ ...s, busy: false, mainIndex: 0 }));
      setMessage(`✓ Removed ${key.name}`);
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function runCheckKey(all: boolean) {
    setUi((s) => ({ ...s, busy: true }));
    setMessage(all ? "Checking all keys…" : "Checking key…");
    try {
      if (all) {
        const results = await checkAllApiKeys(services);
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
        const key = keys[ui.mainIndex - 1];
        if (!key) {
          setMessage("Select a stored key (or press C for Check All)");
          return;
        }
        const { status } = await checkApiKey(services, key.id);
        setKeysVersion((v) => v + 1);
        setMessage(
          status.valid
            ? `✓ ${key.name}: valid · auth · reachable · models=${status.modelsAvailable}`
            : `✗ ${key.name}: ${status.message}`,
        );
      }
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function refreshExecutors() {
    setUi((s) => ({ ...s, busy: true }));
    setMessage("Detecting executors…");
    try {
      const detections = await detectExecutors(services);
      setExecutorRows(
        detections.map((d) => ({
          id: d.id,
          name: d.name,
          detection: d.detection,
          installPlan: services.executors.get(d.id)?.installPlan?.(),
        })),
      );
      setMessage(`Detected ${detections.length} executor(s)`);
      setExecutorDetail("");
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function showInstallPlan() {
    const list =
      executorRows.length > 0
        ? executorRows
        : services.executors.list().map((e) => ({
            id: e.id,
            name: e.name,
            installPlan: e.installPlan?.(),
          }));
    const row = list[ui.mainIndex];
    if (!row) return;
    const plan = row.installPlan;
    if (!plan) {
      setExecutorDetail(`No install plan for ${row.name}`);
      setMessage(`No install plan for ${row.name}`);
      return;
    }
    setExecutorDetail(`${plan.command}${plan.notes ? ` — ${plan.notes}` : ""}`);
    setMessage(`Install plan: ${plan.command}`);
  }

  async function refreshTasks() {
    setUi((s) => ({ ...s, busy: true }));
    try {
      const list = await listProjectTasks(services.projectPath);
      setTasks(list);
      setMessage(list.length ? `${list.length} task(s)` : "No tasks found");
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function onActivate() {
    const { screen, dialog, mainIndex, focus } = ui;

    if (focus === "nav") {
      setUi((s) =>
        reduceUi({ ...s, mainItemCount }, { type: "select_nav" }),
      );
      setMessage("");
      return;
    }

    if (dialog === "add-key") {
      void advanceAddKey(addStep === "provider" ? mainIndex : addProviderIdx);
      return;
    }

    if (dialog === "confirm-uninstall") {
      if (mainIndex === 1) {
        setUi((s) => ({ ...s, dialog: "none", mainIndex: 1 }));
        setMessage("Uninstall cancelled");
        return;
      }
      setUi((s) => ({ ...s, busy: true }));
      setMessage("Uninstalling…");
      try {
        const result = await performUninstall({ purge: false });
        const tail = result.output.split("\n").slice(-4).join(" · ");
        if (result.code === 0) {
          setMessage(`✓ ${tail || "Assentor CLI removed."}`);
          setTimeout(() => exit(), 800);
        } else {
          setMessage(`✗ Uninstall failed. ${tail}`);
        }
      } finally {
        setUi((s) => ({ ...s, busy: false }));
      }
      return;
    }

    if (dialog === "defaults") {
      const rows = buildDefaultRows(config);
      if (mainIndex === rows.length - 1) {
        setUi((s) => ({ ...s, busy: true }));
        try {
          const saved = await saveGlobalDefaults(services, config);
          setMessage(`✓ Saved global defaults → ${saved}`);
        } finally {
          setUi((s) => ({ ...s, busy: false }));
        }
        return;
      }
      setConfig((prev) =>
        applyDefaultCycle(prev, mainIndex, 1, modelChoices),
      );
      return;
    }

    if (dialog === "review-plan") {
      setUi((s) => ({ ...s, dialog: "none" }));
      return;
    }

    switch (screen) {
      case "keys": {
        if (mainIndex === 0) {
          startAddKeyState();
          setUi((s) => ({
            ...s,
            dialog: "add-key",
            mainIndex: 0,
            focus: "main",
          }));
          return;
        }
        void runCheckKey(false);
        return;
      }
      case "executors": {
        const adapters =
          executorRows.length > 0
            ? executorRows
            : services.executors.list().map((e) => ({
                id: e.id,
                name: e.name,
              }));
        const row = adapters[mainIndex];
        if (!row) return;
        setUi((s) => ({ ...s, busy: true }));
        try {
          const result = await detectExecutor(services, row.id);
          setExecutorRows((prev) => {
            const base =
              prev.length > 0
                ? prev
                : services.executors.list().map((e) => ({
                    id: e.id,
                    name: e.name,
                    installPlan: e.installPlan?.(),
                  }));
            return base.map((r) =>
              r.id === result.id
                ? {
                    ...r,
                    detection: result.detection,
                    installPlan: result.installPlan,
                  }
                : r,
            );
          });
          setMessage(
            result.detection.installed
              ? `✓ ${result.name} at ${result.detection.path}`
              : `✗ Not installed. ${result.installPlan ? `Install: ${result.installPlan.command}` : ""}`,
          );
        } finally {
          setUi((s) => ({ ...s, busy: false }));
        }
        return;
      }
      case "review": {
        if (mainIndex === 4) {
          openReviewPlan();
          setUi((s) => ({ ...s, dialog: "review-plan" }));
        } else {
          setMessage("Change defaults under Settings · press [p] for Review Plan");
        }
        return;
      }
      case "diagnostics": {
        setUi((s) => ({ ...s, busy: true }));
        setMessage("Running full diagnostics…");
        try {
          const items = await runFullDiagnostics(services);
          setDiagLines(
            items.map((i) => `${i.ok ? "✓" : "✗"} ${i.name}: ${i.detail}`),
          );
          setMessage("");
        } finally {
          setUi((s) => ({ ...s, busy: false }));
        }
        return;
      }
      case "logs": {
        setUi((s) => ({ ...s, busy: true }));
        try {
          const events = await loadAuditEvents(services, 40);
          setLogLines(events.map((e) => `${e.at} ${e.type} ${e.message}`));
          setMessage("");
        } finally {
          setUi((s) => ({ ...s, busy: false }));
        }
        return;
      }
      case "settings": {
        if (mainIndex === 0) {
          setUi((s) => ({
            ...s,
            dialog: "defaults",
            mainIndex: 0,
          }));
          setMessage("← → change value · Enter on Save · Esc close");
        }
        return;
      }
      case "system": {
        if (mainIndex === 0) {
          setUi((s) => ({ ...s, busy: true }));
          setMessage(
            updateInfo?.updateAvailable
              ? `Updating to v${updateInfo.latest}…`
              : "Checking for updates / rebuilding…",
          );
          try {
            const check = await performUpdateCheck(true);
            setUpdateInfo(check);
            if (!check.updateAvailable && check.latest) {
              setMessage(
                `✓ Already on latest (v${check.local}). Rebuilding locally…`,
              );
            }
            const result = await performUpdate();
            const refreshed = await performUpdateCheck(true);
            setUpdateInfo(refreshed);
            const tail = result.output.split("\n").slice(-6).join(" · ");
            setMessage(
              result.code === 0
                ? `✓ Updated to v${result.localVersion}. ${tail || "Restart assentor to use the new build."}`
                : `✗ Update failed (exit ${result.code}). ${tail}`,
            );
          } finally {
            setUi((s) => ({ ...s, busy: false }));
          }
          return;
        }
        if (mainIndex === 1) {
          setUi((s) => ({
            ...s,
            dialog: "confirm-uninstall",
            mainIndex: 0,
          }));
          setMessage("Confirm uninstall");
          return;
        }
        if (mainIndex === 2) {
          exit();
        }
        return;
      }
      case "tasks": {
        void refreshTasks();
        return;
      }
      case "dashboard": {
        setMessage(
          `Defaults: executor=${config.executor.provider} reviewer=${config.reviewers[0]?.provider}. Run: assentor run --project . "…"`,
        );
        return;
      }
      default:
        return;
    }
  }

  const status = deriveStatus(ui.screen, ui.busy, updateInfo, keys);
  const dialogForKeys: "none" | "add-key" =
    ui.dialog === "add-key" ? "add-key" : "none";
  const dialogForReview: "none" | "review-plan" =
    ui.dialog === "review-plan" ? "review-plan" : "none";
  const dialogForSettings: "none" | "defaults" =
    ui.dialog === "defaults" ? "defaults" : "none";
  const dialogForSystem: "none" | "confirm-uninstall" =
    ui.dialog === "confirm-uninstall" ? "confirm-uninstall" : "none";

  const footerState: UiState = {
    ...ui,
    capturingText,
    mainItemCount,
  };

  return (
    <Shell
      version={localVersion}
      screen={ui.screen}
      focus={ui.focus}
      navIndex={ui.navIndex}
      statusLabel={status.label}
      statusTone={status.tone}
      message={message}
      busy={ui.busy}
      footer={footerHints(footerState)}
    >
      {ui.screen === "dashboard" && (
        <DashboardScreen
          services={services}
          config={config}
          version={localVersion}
          updateInfo={updateInfo}
          keyCount={keys.length}
          agentCount={agents.length}
        />
      )}
      {ui.screen === "tasks" && (
        <TasksScreen
          tasks={tasks}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
        />
      )}
      {ui.screen === "agents" && (
        <AgentsScreen
          agents={agents}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
        />
      )}
      {ui.screen === "executors" && (
        <ExecutorsScreen
          rows={
            executorRows.length > 0
              ? executorRows
              : services.executors.list().map((e) => ({
                  id: e.id,
                  name: e.name,
                  installPlan: e.installPlan?.(),
                }))
          }
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
          detail={executorDetail}
        />
      )}
      {ui.screen === "providers" && (
        <ProvidersScreen
          providers={providers}
          keys={keys}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
        />
      )}
      {ui.screen === "models" && (
        <ModelsScreen
          models={models}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
        />
      )}
      {ui.screen === "keys" && (
        <KeysScreen
          keys={keys}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
          dialog={dialogForKeys}
          addStep={addStep}
          addProviderIdx={addProviderIdx}
          addName={addName}
          addSecret={addSecret}
        />
      )}
      {ui.screen === "review" && (
        <ReviewScreen
          config={config}
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
          dialog={dialogForReview}
          plan={reviewPlan}
          planTaskPreview={
            "Review architecture and security for auth refactor with tests"
          }
          liveLines={[]}
        />
      )}
      {ui.screen === "diagnostics" && (
        <DiagnosticsScreen lines={diagLines} />
      )}
      {ui.screen === "logs" && <LogsScreen lines={logLines} />}
      {ui.screen === "settings" && (
        <SettingsScreen
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
          dialog={dialogForSettings}
          config={config}
          projectPath={services.projectPath}
          defaultSelected={ui.mainIndex}
        />
      )}
      {ui.screen === "system" && (
        <SystemScreen
          selected={ui.mainIndex}
          focused={ui.focus === "main"}
          updateInfo={updateInfo}
          version={localVersion}
          dialog={dialogForSystem}
          confirmSelected={ui.mainIndex}
        />
      )}
    </Shell>
  );
}

function deriveStatus(
  screen: ScreenId,
  busy: boolean,
  updateInfo: UpdateCheckResult | null,
  keys: { health: string }[],
): { label: string; tone: "ok" | "warn" | "error" | "info" | "brand" } {
  if (busy) return { label: "busy", tone: "info" };
  if (updateInfo?.updateAvailable) return { label: "update", tone: "warn" };
  if (screen === "keys") {
    const failed = keys.some((k) => k.health === "failed");
    if (failed) return { label: "keys!", tone: "error" };
    return { label: `${keys.length} keys`, tone: "ok" };
  }
  return { label: screen, tone: "brand" };
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
      next.reviewers = [{ provider, role: "general", transport: "api" }];
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

export { App };
export type { ScreenId };
export {
  NAV_SCREENS,
  mapKeyToAction,
  reduceUi,
  createInitialUiState,
  screenAt,
} from "./keymap.js";
export type { DialogKind, UiState, UiAction, KeyEvent } from "./keymap.js";
