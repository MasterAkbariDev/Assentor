import React, { useEffect, useMemo, useState } from "react";
import { useApp, useInput, render, Box, Text } from "ink";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  analyzeReviewPlan,
  checkAllApiKeys,
  checkApiKey,
  createAssentorServices,
  detectExecutor,
  detectExecutors,
  getLocalVersionSync,
  listProjectTasks,
  deleteProjectTask,
  performUninstall,
  performUpdate,
  performUpdateCheck,
  runFullDiagnostics,
  saveGlobalDefaults,
  type AssentorServices,
  type DiagnosticItem,
} from "../services/app.js";
import { formatRunMode, type Autonomy } from "../core/run-mode.js";
import { formatExecutorProvider } from "../executors/providers.js";
import { loadAssentorConfig, type AssentorConfig } from "../config/load.js";
import { explainReviewPlan } from "../review/complexity.js";
import {
  REVIEWER_ADD_PROVIDERS,
  getAvailableReviewerProviders,
  defaultTransportForProvider,
  transportsForProvider,
} from "../review/backends.js";
import { listEnvKeyPresence } from "../keys/resolve.js";
import { isFailedResumeStatus } from "../orchestrator/state-machine.js";
import type { UpdateCheckResult } from "../self/index.js";
import type { TaskSnapshot } from "../persistence/store.js";
import type { ComplexityAnalysis } from "../review/complexity.js";
import { findEditTarget, forkPrompt, launchEditor, type EditTarget } from "../cli/prompts.js";
import {
  PromptLibrary,
  type PromptDefinition,
  type PromptLibraryLoadOptions,
} from "../prompts/index.js";
import { orderedPrompts, PREVIEW_LINES, validateSummary } from "./screens/agents.js";
import { Dialog } from "./components/dialog.js";
import {
  CommandPalette,
  HelpOverlay,
  ReviewPlanDialog,
  StartTaskDialog,
  AddReviewerDialog,
} from "./components/overlays.js";
import type { AddReviewerStep } from "./components/overlays.js";
import { Shell } from "./layout/shell.js";
import { createInkStdout } from "./stdout.js";
import { resetTerminalForRelaunch } from "../cli/terminal.js";
import { relaunchAssentor } from "../self/lifecycle.js";
import {
  createInitialUiState,
  filterPaletteCommands,
  footerHints,
  mapKeyToAction,
  NAV_SCREENS,
  reduceUi,
  screenAt,
  type ConfigSection,
  type ScreenId,
  type UiState,
} from "./keymap.js";
import {
  AgentsScreen,
  buildAdvancedRows,
  buildAiRows,
  buildReviewRows,
  buildReviewMenu,
  CONFIG_MENU,
  ConfigurationScreen,
  cycleAiField,
  cycleRunMode,
  cycleAdvancedField,
  cycleReviewField,
  removeReviewerAt,
  DiagnosticsScreen,
  type ExecutorRow,
  HelpScreen,
  KEY_PROVIDERS,
  type AddKeyStep,
  KeysScreen,
  MenuList,
  REVIEW_ACTIONS,
  ReviewScreen,
  TasksScreen,
  WORKSPACE_ACTIONS,
  WorkspaceScreen,
} from "./screens/index.js";

export type TuiHandoff =
  | { kind: "exit" }
  | {
      kind: "run";
      projectPath: string;
      prompt: string;
      executor?: string;
      /** Effective autonomy, so `manual` is not turned into supervised on the way to the run. */
      autonomy?: Autonomy;
    }
  | { kind: "resume"; projectPath: string; taskId: string }
  | { kind: "relaunch"; args: string[] }
  /** Open `file` in the editor, then show the TUI again on the Agents screen. */
  | { kind: "edit-prompt"; file: string };

/** Where the prompt library comes from. Tests point it at temp dirs. */
export interface PromptDirs {
  userDir?: string;
  builtinDir?: string;
}

/** Outcome of a library load: the library, or the message of the error that stopped it. */
type LoadPromptsResult = { ok: true; library: PromptLibrary } | { ok: false; message: string };

function isRetryableTaskStatus(status: string): boolean {
  return (
    status !== "DONE" &&
    status !== "CANCELLED" &&
    status !== "BUDGET_EXCEEDED"
  );
}

export function App({
  services,
  initialConfig,
  onHandoff,
  initialUi,
  initialNotice,
  initialPromptId,
  promptDirs,
  loadPrompts,
}: {
  services: AssentorServices;
  initialConfig: AssentorConfig;
  onHandoff: (handoff: TuiHandoff) => void;
  /** Starting screen and selection (the edit loop reopens on Agents). */
  initialUi?: Partial<UiState>;
  /** Shown once on start, e.g. why an editor failed to open. */
  initialNotice?: string[];
  /** Prompt to select once the library loads (the one just edited). */
  initialPromptId?: string;
  promptDirs?: PromptDirs;
  /** Loads the prompt library. Default `PromptLibrary.load`; tests inject failures here. */
  loadPrompts?: (options: PromptLibraryLoadOptions) => Promise<PromptLibrary>;
}) {
  const { exit } = useApp();
  const localVersion = useMemo(() => getLocalVersionSync(), []);

  const [ui, setUi] = useState<UiState>(() => createInitialUiState(initialUi));
  const [promptLibrary, setPromptLibrary] = useState<PromptLibrary | null>(null);
  const [promptPreview, setPromptPreview] = useState<{ scroll: number } | null>(null);
  const [forkPending, setForkPending] = useState(false);
  const [promptNotice, setPromptNotice] = useState<string[]>(initialNotice ?? []);
  const [promptLoadError, setPromptLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<AssentorConfig>(initialConfig);
  const [message, setMessage] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);
  const [diagItems, setDiagItems] = useState<DiagnosticItem[]>([]);
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [executorRows, setExecutorRows] = useState<ExecutorRow[]>([]);
  const [reviewPlan, setReviewPlan] = useState<ComplexityAnalysis | null>(null);

  const [addStep, setAddStep] = useState<AddKeyStep>("provider");
  const [addProviderIdx, setAddProviderIdx] = useState(0);
  const [addName, setAddName] = useState("Personal");
  const [addSecret, setAddSecret] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [startTaskPath, setStartTaskPath] = useState(services.projectPath);
  const [startTaskStep, setStartTaskStep] = useState<"path" | "goal" | "confirm">(
    "path",
  );
  const [planGoal, setPlanGoal] = useState("");
  const [planCapturing, setPlanCapturing] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [addReviewerStep, setAddReviewerStep] =
    useState<AddReviewerStep>("provider");
  const [addReviewerProviderIdx, setAddReviewerProviderIdx] = useState(0);
  const [addReviewerTransportIdx, setAddReviewerTransportIdx] = useState(0);
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(
    null,
  );

  const envHints = useMemo(() => listEnvKeyPresence(), [keysVersion]);

  const keys = useMemo(() => {
    void keysVersion;
    return services.vault.list();
  }, [services, keysVersion]);
  const agents = services.agents.list();
  const models = services.models.list();
  const promptList = useMemo(
    () => (promptLibrary ? orderedPrompts(promptLibrary.list()) : []),
    [promptLibrary],
  );
  const selectedPrompt: PromptDefinition | undefined = promptList[ui.mainIndex];

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

  const availableReviewerProviders = useMemo(() => {
    return getAvailableReviewerProviders();
  }, []);

  const addReviewerProvider =
    availableReviewerProviders[addReviewerProviderIdx] ??
    availableReviewerProviders[0] ??
    "gemini";
  const addReviewerTransports = transportsForProvider(addReviewerProvider);
  const addReviewerKeyChoices = useMemo(() => {
    const providerKeys = keys.filter((k) => k.provider === addReviewerProvider);
    return [
      ...providerKeys.map((k) => ({
        id: k.id,
        name: k.name,
        label: `${k.name}  ${k.masked}`,
      })),
      { id: undefined as string | undefined, name: undefined, label: "Use environment / resolve at run time" },
    ];
  }, [keys, addReviewerProvider]);

  const paletteCommands = useMemo(
    () => filterPaletteCommands(paletteQuery),
    [paletteQuery],
  );

  const mainItemCount = useMemo(() => {
    if (ui.dialog === "palette") return Math.max(paletteCommands.length, 1);
    if (ui.dialog === "add-key") {
      return addStep === "provider" ? KEY_PROVIDERS.length : 1;
    }
    if (ui.dialog === "add-reviewer") {
      if (addReviewerStep === "provider") return availableReviewerProviders.length;
      if (addReviewerStep === "transport")
        return Math.max(addReviewerTransports.length, 1);
      return Math.max(addReviewerKeyChoices.length, 1);
    }
    if (ui.dialog === "confirm-uninstall" || ui.dialog === "confirm-delete-task")
      return 2;
    if (ui.dialog === "review-plan" || ui.dialog === "help") return 1;
    if (ui.dialog === "start-task") return 1;

    switch (ui.screen) {
      case "workspace":
        return WORKSPACE_ACTIONS.length;
      case "tasks":
        return ui.selectedTaskId ? 1 : Math.max(tasks.length, 1);
      case "agents":
        return Math.max(promptList.length, 1);
      case "review":
        return REVIEW_ACTIONS.length;
      case "configuration":
        if (ui.configSection === "menu") return CONFIG_MENU.length;
        if (ui.configSection === "keys") return Math.max(keys.length + 1, 1);
        if (ui.configSection === "executors") {
          return Math.max(
            executorRows.length || services.executors.list().length,
            1,
          );
        }
        if (ui.configSection === "system") return 3;
        if (ui.configSection === "ai") return buildAiRows(config).length;
        if (ui.configSection === "review") return buildReviewRows(config).length;
        if (ui.configSection === "advanced")
          return buildAdvancedRows(config).length;
        return 1;
      case "diagnostics":
        return Math.max(diagItems.length, 1);
      case "help":
        return 1;
      default:
        return 1;
    }
  }, [
    ui.dialog,
    ui.screen,
    ui.selectedTaskId,
    ui.configSection,
    addStep,
    addReviewerStep,
    addReviewerTransports.length,
    addReviewerKeyChoices.length,
    config,
    tasks.length,
    promptList.length,
    executorRows.length,
    services.executors,
    keys.length,
    diagItems.length,
    paletteCommands.length,
  ]);

  useEffect(() => {
    setUi((s) => ({
      ...s,
      mainItemCount,
      mainIndex: Math.min(s.mainIndex, Math.max(0, mainItemCount - 1)),
    }));
  }, [mainItemCount]);

  useEffect(() => {
    void performUpdateCheck(false).then(setUpdateInfo);
    void listProjectTasks(services.projectPath).then(setTasks);
    void refreshExecutors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshExecutors() {
    const detected = await detectExecutors(services);
    const available = detected
      .filter((d) => d.detection.installed)
      .map((d) => ({
        id: d.id,
        name: d.name,
        detection: d.detection,
        installPlan: services.executors.get(d.id)?.installPlan?.(),
      }));
    setExecutorRows(available);
  }

  function patchUi(partial: Partial<UiState>) {
    setUi((s) => ({ ...s, ...partial }));
  }

  function goScreen(
    screen: ScreenId,
    extras: Partial<UiState> = {},
  ) {
    const navIndex = Math.max(
      0,
      NAV_SCREENS.findIndex((n) => n.id === screen),
    );
    setUi((s) => ({
      ...s,
      screen,
      navIndex,
      focus: "main",
      mainIndex: 0,
      dialog: "none",
      capturingText: false,
      selectedTaskId: null,
      ...extras,
    }));
  }

  async function runDiagnostics() {
    patchUi({ busy: true });
    setMessage("Checking…");
    try {
      const items = await runFullDiagnostics(services);
      setDiagItems(items);
      const bad = items.filter((i) => !i.ok).length;
      setMessage(bad === 0 ? "All checks passed" : `${bad} issue(s) found`);
    } finally {
      patchUi({ busy: false });
    }
  }

  async function openReviewPlan(goal?: string) {
    const text = (goal ?? planGoal).trim();
    if (!text) {
      setPlanGoal("");
      setPlanCapturing(true);
      patchUi({
        dialog: "review-plan",
        capturingText: true,
        focus: "dialog",
      });
      return;
    }
    setPlanCapturing(false);
    patchUi({ busy: true, dialog: "review-plan", capturingText: false });
    setMessage("Figuring out reviewers…");
    try {
      const plan = analyzeReviewPlan(text);
      setReviewPlan(plan);
      const explained = explainReviewPlan(plan);
      setMessage(explained.headline);
    } finally {
      patchUi({ busy: false });
    }
  }

  function applyPalette(index: number) {
    const cmd = paletteCommands[index] ?? paletteCommands[0];
    if (!cmd) {
      patchUi({ dialog: "none", focus: "main" });
      return;
    }
    setPaletteQuery("");
    if (cmd.dialog === "start-task") {
      setTaskPrompt("");
      setStartTaskPath(services.projectPath);
      setStartTaskStep("path");
      patchUi({
        dialog: "start-task",
        capturingText: true,
        focus: "dialog",
        mainIndex: 0,
      });
      return;
    }
    if (cmd.dialog === "review-plan") {
      setPlanGoal("");
      void openReviewPlan("");
      return;
    }
    if (cmd.dialog === "ai-defaults") {
      goScreen("configuration", {
        configSection: "ai",
        dialog: "none",
        focus: "main",
      });
      return;
    }
    if (cmd.id === "mode-cycle") {
      const next = cycleRunMode(config);
      setConfig(next);
      setMessage(`Mode: ${formatRunMode(next.run.mode)}`);
      patchUi({ dialog: "none", focus: "main" });
      return;
    }
    if (cmd.dialog === "help") {
      patchUi({ dialog: "help", focus: "dialog" });
      return;
    }
    if (cmd.screen) {
      goScreen(cmd.screen, {
        configSection: cmd.configSection ?? "menu",
      });
      if (cmd.screen === "diagnostics") void runDiagnostics();
    } else {
      patchUi({ dialog: "none", focus: "main" });
    }
  }

  async function saveConfigDefaults() {
    await saveGlobalDefaults(services, config);
    setMessage("Saved defaults to ~/.assentor/config.yaml");
  }

  function resetAddReviewer() {
    setAddReviewerStep("provider");
    setAddReviewerProviderIdx(0);
    setAddReviewerTransportIdx(0);
  }

  function openAddReviewer() {
    resetAddReviewer();
    patchUi({
      dialog: "add-reviewer",
      focus: "dialog",
      mainIndex: 0,
      capturingText: false,
    });
  }

  function commitReviewer(entry: {
    provider: (typeof REVIEWER_ADD_PROVIDERS)[number];
    transport: "api" | "cli";
    keyId?: string;
    name?: string;
  }) {
    setConfig((c) => {
      const next = structuredClone(c);
      next.reviewers = [
        ...next.reviewers,
        {
          provider: entry.provider,
          role: "general",
          transport: entry.transport,
          ...(entry.keyId ? { keyId: entry.keyId } : {}),
          ...(entry.name ? { name: entry.name } : {}),
        },
      ];
      return next;
    });
    resetAddReviewer();
    patchUi({ dialog: "none", focus: "main", configSection: "review" });
    setMessage(
      `Added ${entry.provider} (${entry.transport}) — press s to save`,
    );
  }

  function currentTaskForAction(): TaskSnapshot | undefined {
    if (ui.selectedTaskId) {
      return tasks.find((t) => t.taskId === ui.selectedTaskId);
    }
    return tasks[ui.mainIndex];
  }

  function applyConfigCycle(dir: 1 | -1) {
    const idx = ui.mainIndex;
    if (ui.configSection === "ai") {
      const rows = buildAiRows(config);
      if (idx >= rows.length - 1) return;
      const availableExecutors = executorRows
        .filter((r) => r.detection?.installed)
        .map((r) => r.id);
      setConfig((c) =>
        cycleAiField(
          c,
          idx,
          dir,
          modelChoices,
          availableExecutors.length > 0 ? availableExecutors : undefined,
        ),
      );
      return;
    }
    if (ui.configSection === "review") {
      const rows = buildReviewRows(config);
      if (idx >= rows.length - 1) return;
      setConfig((c) => cycleReviewField(c, idx, dir));
      return;
    }
    if (ui.configSection === "advanced") {
      const rows = buildAdvancedRows(config);
      if (idx >= rows.length - 1) return;
      setConfig((c) => cycleAdvancedField(c, idx, dir));
    }
  }

  async function advanceStartTask() {
    if (startTaskStep === "path") {
      const folder = path.resolve(startTaskPath.trim() || services.projectPath);
      try {
        await fs.access(folder);
      } catch {
        setMessage(`Folder not found: ${folder}`);
        return;
      }
      setStartTaskPath(folder);
      setStartTaskStep("goal");
      patchUi({ capturingText: true });
      return;
    }
    if (startTaskStep === "goal") {
      const prompt = taskPrompt.trim();
      if (!prompt) {
        setMessage("Type a goal first");
        return;
      }
      setStartTaskStep("confirm");
      patchUi({ capturingText: true, focus: "dialog" });
      const plan = analyzeReviewPlan(prompt);
      setReviewPlan(plan);
      return;
    }
    setMessage("Starting task…");
    onHandoff({
      kind: "run",
      projectPath: path.resolve(startTaskPath),
      prompt: taskPrompt.trim(),
      executor: config.executor.provider,
      autonomy: config.run.autonomy ?? config.run.mode,
    });
    exit();
  }

  async function handleActivate() {
    if (ui.dialog === "palette") {
      applyPalette(ui.mainIndex);
      return;
    }

    if (ui.dialog === "help") {
      patchUi({ dialog: "none", focus: "main" });
      return;
    }

    if (ui.dialog === "review-plan") {
      if (planCapturing) {
        const text = planGoal.trim();
        if (!text) {
          setMessage("Type a goal first");
          return;
        }
        void openReviewPlan(text);
        return;
      }
      patchUi({ dialog: "none", capturingText: false, focus: "main" });
      return;
    }

    if (ui.dialog === "start-task") {
      await advanceStartTask();
      return;
    }

    if (ui.dialog === "add-reviewer") {
      if (addReviewerStep === "provider") {
        const idx = ui.mainIndex;
        const provider = availableReviewerProviders[idx] ?? "mock";
        setAddReviewerProviderIdx(idx);
        setAddReviewerTransportIdx(0);
        const transports = transportsForProvider(provider);
        if (transports.length <= 1) {
          const transport = transports[0] ?? defaultTransportForProvider(provider);
          if (transport === "cli" || provider === "mock") {
            commitReviewer({ provider, transport });
            return;
          }
          setAddReviewerStep("key");
          patchUi({ mainIndex: 0 });
          return;
        }
        setAddReviewerStep("transport");
        patchUi({ mainIndex: 0 });
        return;
      }
      if (addReviewerStep === "transport") {
        const transport =
          addReviewerTransports[ui.mainIndex] ??
          defaultTransportForProvider(addReviewerProvider);
        setAddReviewerTransportIdx(ui.mainIndex);
        if (transport === "cli" || addReviewerProvider === "mock") {
          commitReviewer({ provider: addReviewerProvider, transport });
          return;
        }
        setAddReviewerStep("key");
        patchUi({ mainIndex: 0 });
        return;
      }
      const choice = addReviewerKeyChoices[ui.mainIndex];
      const transport =
        addReviewerTransports[addReviewerTransportIdx] ??
        defaultTransportForProvider(addReviewerProvider);
      commitReviewer({
        provider: addReviewerProvider,
        transport,
        keyId: choice?.id,
        name: choice?.name,
      });
      return;
    }

    if (ui.dialog === "confirm-delete-task") {
      if (ui.mainIndex === 0 && pendingDeleteTaskId) {
        try {
          await deleteProjectTask(services.projectPath, pendingDeleteTaskId);
          const next = await listProjectTasks(services.projectPath);
          setTasks(next);
          setPendingDeleteTaskId(null);
          patchUi({
            dialog: "none",
            selectedTaskId: null,
            focus: "main",
            mainIndex: 0,
          });
          setMessage("Task deleted");
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not delete task",
          );
          patchUi({ dialog: "none", focus: "main" });
        }
      } else {
        setPendingDeleteTaskId(null);
        patchUi({ dialog: "none", focus: "main" });
      }
      return;
    }

    if (ui.dialog === "confirm-uninstall") {
      if (ui.mainIndex === 0) {
        patchUi({ busy: true });
        const result = await performUninstall({ purge: false });
        setMessage(result.output.slice(0, 200));
        patchUi({ busy: false, dialog: "none" });
      } else {
        patchUi({ dialog: "none", focus: "main" });
      }
      return;
    }

    if (ui.dialog === "ai-defaults") {
      patchUi({ dialog: "none", focus: "main" });
      return;
    }

    if (ui.dialog === "add-key") {
      if (addStep === "provider") {
        setAddProviderIdx(ui.mainIndex);
        setAddStep("name");
        patchUi({ capturingText: true, mainIndex: 0 });
        return;
      }
      if (addStep === "name") {
        setAddStep("secret");
        patchUi({ capturingText: true });
        return;
      }
      if (addStep === "secret") {
        if (!addSecret.trim()) {
          setMessage("Paste a non-empty API key");
          return;
        }
        await services.vault.add({
          provider: KEY_PROVIDERS[addProviderIdx]!,
          name: addName.trim() || "Personal",
          secret: addSecret.trim(),
        });
        setKeysVersion((v) => v + 1);
        setAddStep("provider");
        setAddName("Personal");
        setAddSecret("");
        setMessage("API key saved");
        patchUi({ dialog: "none", capturingText: false, focus: "main" });
      }
      return;
    }

    // Main screen activations
    if (ui.screen === "workspace") {
      const action = WORKSPACE_ACTIONS[ui.mainIndex];
      if (action?.id === "start") {
        setTaskPrompt("");
        setStartTaskPath(services.projectPath);
        setStartTaskStep("path");
        patchUi({
          dialog: "start-task",
          capturingText: true,
          focus: "dialog",
        });
      } else if (action?.id === "continue") {
        const latest = tasks.find((t) => isRetryableTaskStatus(t.status));
        if (latest) {
          onHandoff({
            kind: "resume",
            projectPath: services.projectPath,
            taskId: latest.taskId,
          });
          exit();
        } else {
          setMessage("No resumable task — start a new one");
        }
      } else if (action?.id === "review") {
        setPlanGoal("");
        void openReviewPlan("");
      } else if (action?.id === "diagnostics") {
        goScreen("diagnostics");
        void runDiagnostics();
      }
      return;
    }

    if (ui.screen === "tasks") {
      if (ui.selectedTaskId) {
        return;
      }
      const task = tasks[ui.mainIndex];
      if (task) {
        patchUi({ selectedTaskId: task.taskId });
      }
      return;
    }

    if (ui.screen === "review") {
      const action = REVIEW_ACTIONS[ui.mainIndex];
      if (action?.id === "plan") {
        setPlanGoal("");
        void openReviewPlan("");
      }
      if (action?.id === "strategy") {
        goScreen("configuration", {
          configSection: "review",
          dialog: "none",
          focus: "main",
        });
      }
      return;
    }

    if (ui.screen === "configuration") {
      if (ui.configSection === "menu") {
        const item = CONFIG_MENU[ui.mainIndex];
        if (!item) return;
        if (item.id === "ai" || item.id === "review" || item.id === "advanced") {
          patchUi({
            configSection: item.id,
            dialog: "none",
            focus: "main",
            mainIndex: 0,
          });
        } else {
          patchUi({ configSection: item.id as ConfigSection, mainIndex: 0 });
          if (item.id === "executors") void refreshExecutors();
        }
        return;
      }
      if (ui.configSection === "review") {
        const row = buildReviewMenu(config)[ui.mainIndex];
        if (row?.kind === "add") {
          openAddReviewer();
          return;
        }
        if (row?.kind === "save") {
          await saveConfigDefaults();
          return;
        }
        if (row?.kind === "strategy" || row?.kind === "rounds") {
          applyConfigCycle(1);
        }
        return;
      }
      if (ui.configSection === "ai" || ui.configSection === "advanced") {
        const rows =
          ui.configSection === "ai"
            ? buildAiRows(config)
            : buildAdvancedRows(config);
        if (ui.mainIndex === rows.length - 1) {
          await saveConfigDefaults();
          return;
        }
        applyConfigCycle(1);
        return;
      }
      if (ui.configSection === "keys") {
        if (ui.mainIndex === 0) {
          setAddStep("provider");
          patchUi({ dialog: "add-key", focus: "dialog", mainIndex: 0 });
        }
        return;
      }
      if (ui.configSection === "executors") {
        const row = executorRows[ui.mainIndex];
        if (row) {
          const result = await detectExecutor(services, row.id);
          setMessage(
            result.detection.installed
              ? `✓ ${row.name} at ${result.detection.path}`
              : `✗ ${row.name}: ${result.detection.error ?? "missing"}`,
          );
          void refreshExecutors();
        }
        return;
      }
      if (ui.configSection === "system") {
        if (ui.mainIndex === 0) {
          patchUi({ busy: true });
          const info = await performUpdateCheck(true);
          setUpdateInfo(info);
          setMessage(info.message);
          patchUi({ busy: false });
        } else if (ui.mainIndex === 1) {
          patchUi({ busy: true });
          const result = await performUpdate();
          if (result.code === 0) {
            onHandoff({
              kind: "relaunch",
              args: ["ui", "-p", services.projectPath],
            });
            return;
          }
          setMessage(
            result.output.slice(0, 240) || `Update failed (${result.code})`,
          );
          patchUi({ busy: false });
        } else if (ui.mainIndex === 2) {
          patchUi({
            dialog: "confirm-uninstall",
            focus: "dialog",
            mainIndex: 1,
          });
        }
      }
      return;
    }

    if (ui.screen === "diagnostics") {
      void runDiagnostics();
    }
  }

  /**
   * Load (or reload) the prompt library. A rejected load does not throw: its
   * message is kept for the screen, the spinner stops, and `v` retries. `keepId`
   * is the prompt to select afterwards, so a fork or reload keeps the selection.
   */
  async function loadPromptLibrary(keepId?: string): Promise<LoadPromptsResult> {
    try {
      const library = await (loadPrompts ?? ((options) => PromptLibrary.load(options)))({
        projectPath: services.projectPath,
        userDir: promptDirs?.userDir,
        builtinDir: promptDirs?.builtinDir,
      });
      setPromptLibrary(library);
      setPromptLoadError(null);
      selectPromptAfterLoad(library, keepId);
      return { ok: true, library };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPromptLoadError(message);
      return { ok: false, message };
    }
  }

  /** Select `id` in the new list; when it is gone, keep the old index within the list. */
  function selectPromptAfterLoad(library: PromptLibrary, id: string | undefined): void {
    const ids = orderedPrompts(library.list());
    const index = id ? ids.findIndex((prompt) => prompt.id === id) : -1;
    setUi((s) => ({
      ...s,
      mainIndex: index >= 0 ? index : Math.min(s.mainIndex, Math.max(0, ids.length - 1)),
    }));
  }

  useEffect(() => {
    if (ui.screen === "agents" && promptLibrary === null && promptLoadError === null) {
      void loadPromptLibrary(initialPromptId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.screen, promptLibrary, promptLoadError]);

  /** `f` then `u` or `p`: same copy as `assentor prompts fork`, then reload. */
  async function forkSelectedPrompt(to: "user" | "project"): Promise<void> {
    if (!selectedPrompt) return;
    const id = selectedPrompt.id;
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await forkPrompt({
        projectPath: services.projectPath,
        userDir: promptDirs?.userDir,
        builtinDir: promptDirs?.builtinDir,
        id,
        to,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      setPromptNotice(code === 0 ? out : err);
    } catch (error) {
      // Filesystem errors such as EACCES or EROFS come back as a rejection.
      setPromptNotice([`Fork failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
    await loadPromptLibrary(id);
  }

  /** `e`: the project copy, else the user copy. Leaves the TUI so the editor can run. */
  function editSelectedPrompt(): void {
    if (!selectedPrompt || !promptLibrary) return;
    const target = findEditTarget(promptLibrary, selectedPrompt.id);
    if (target.kind !== "copy") {
      setPromptNotice([
        `Only the built-in prompt "${selectedPrompt.id}" exists. Fork it first (f).`,
      ]);
      return;
    }
    onHandoff({ kind: "edit-prompt", file: target.file });
    exit();
  }

  /** `v`: reload and report. Load errors show in the warning panel. */
  async function validatePromptLibrary(): Promise<void> {
    const result = await loadPromptLibrary(selectedPrompt?.id);
    setPromptNotice([
      result.ok
        ? validateSummary(result.library.list().length, result.library.errors.length)
        : `Validation could not run: ${result.message}`,
    ]);
  }

  useInput((input, key) => {
    if (ui.dialog === "palette") {
      if (key.escape) {
        setPaletteQuery("");
        setUi((s) => reduceUi(s, { type: "escape" }));
        return;
      }
      if (key.backspace || key.delete) {
        setPaletteQuery((q) => q.slice(0, -1));
        return;
      }
      if (key.upArrow || key.downArrow || key.return) {
        const action = mapKeyToAction(ui, {
          input,
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          return: key.return,
          escape: key.escape,
          ctrl: key.ctrl,
        });
        if (action.type === "activate") {
          void handleActivate();
          return;
        }
        setUi((s) => reduceUi(s, action));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPaletteQuery((q) => q + input);
        setUi((s) => ({ ...s, mainIndex: 0 }));
        return;
      }
    }

    if (ui.capturingText && ui.dialog === "start-task") {
      if (key.escape) {
        setTaskPrompt("");
        setStartTaskStep("path");
        setUi((s) => reduceUi(s, { type: "escape" }));
        return;
      }
      if (key.return) {
        void handleActivate();
        return;
      }
      if (startTaskStep === "confirm") {
        return;
      }
      if (key.backspace || key.delete) {
        if (startTaskStep === "path") {
          setStartTaskPath((t) => t.slice(0, -1));
        } else {
          setTaskPrompt((t) => t.slice(0, -1));
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (startTaskStep === "path") setStartTaskPath((t) => t + input);
        else setTaskPrompt((t) => t + input);
        return;
      }
      return;
    }

    if (ui.capturingText && ui.dialog === "review-plan") {
      if (key.escape) {
        setPlanGoal("");
        setPlanCapturing(false);
        setUi((s) => reduceUi(s, { type: "escape" }));
        return;
      }
      if (key.return) {
        void handleActivate();
        return;
      }
      if (key.backspace || key.delete) {
        setPlanGoal((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPlanGoal((t) => t + input);
        return;
      }
      return;
    }

    if (ui.capturingText && ui.dialog === "add-key") {
      if (key.escape) {
        setAddStep("provider");
        setAddSecret("");
        setUi((s) => reduceUi(s, { type: "escape" }));
        return;
      }
      if (key.return) {
        void handleActivate();
        return;
      }
      if (key.backspace || key.delete) {
        if (addStep === "name") setAddName((n) => n.slice(0, -1));
        if (addStep === "secret") setAddSecret((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (addStep === "name") setAddName((n) => n + input);
        if (addStep === "secret") setAddSecret((s) => s + input);
        return;
      }
      return;
    }

    // Agents: while the preview or the fork choice is open, it owns the keys.
    if (ui.screen === "agents" && ui.focus === "main" && ui.dialog === "none") {
      if (promptPreview) {
        const maxScroll = Math.max(
          0,
          (selectedPrompt?.body.split("\n").length ?? 0) - PREVIEW_LINES,
        );
        if (key.escape || key.return) {
          setPromptPreview(null);
          return;
        }
        if (key.upArrow || input === "k") {
          setPromptPreview((p) => ({ scroll: Math.max(0, (p?.scroll ?? 0) - 1) }));
          return;
        }
        if (key.downArrow || input === "j") {
          setPromptPreview((p) => ({ scroll: Math.min(maxScroll, (p?.scroll ?? 0) + 1) }));
          return;
        }
        return;
      }
      if (forkPending) {
        if (key.escape) {
          setForkPending(false);
          return;
        }
        if (input === "u" || input === "p") {
          setForkPending(false);
          void forkSelectedPrompt(input === "u" ? "user" : "project");
          return;
        }
        return;
      }
    }

    const action = mapKeyToAction(ui, {
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
    });

    if (action.type === "quit") {
      exit();
      return;
    }

    if (action.type === "agents_preview") {
      if (!selectedPrompt) return;
      setPromptPreview((p) => (p ? null : { scroll: 0 }));
      return;
    }

    if (action.type === "agents_fork") {
      if (!selectedPrompt) return;
      setForkPending(true);
      return;
    }

    if (action.type === "agents_edit") {
      editSelectedPrompt();
      return;
    }

    if (action.type === "agents_validate") {
      void validatePromptLibrary();
      return;
    }

    if (action.type === "activate" || action.type === "space") {
      void handleActivate();
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "open_palette") {
      setPaletteQuery("");
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "start_task") {
      setTaskPrompt("");
      setStartTaskPath(services.projectPath);
      setStartTaskStep("path");
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "review_plan") {
      setPlanGoal("");
      void openReviewPlan("");
      return;
    }

    if (action.type === "reviewers_add") {
      openAddReviewer();
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "reviewers_delete") {
      const row = buildReviewMenu(config)[ui.mainIndex];
      if (row?.kind !== "member") {
        setMessage("Select a reviewer row to delete");
        return;
      }
      setConfig((c) => removeReviewerAt(c, row.index));
      setMessage("Removed reviewer — press s to save");
      return;
    }

    if (action.type === "task_resume") {
      const task = currentTaskForAction();
      if (!task) {
        setMessage("Select a task first");
        return;
      }
      if (!isFailedResumeStatus(task.status)) {
        setMessage("Resume is for FAILED or TIMEOUT tasks only");
        return;
      }
      onHandoff({
        kind: "resume",
        projectPath: services.projectPath,
        taskId: task.taskId,
      });
      exit();
      return;
    }

    if (action.type === "task_delete") {
      const task = currentTaskForAction();
      if (!task) {
        setMessage("Select a task first");
        return;
      }
      setPendingDeleteTaskId(task.taskId);
      patchUi({
        dialog: "confirm-delete-task",
        focus: "dialog",
        mainIndex: 1,
      });
      return;
    }

    if (action.type === "keys_add") {
      setAddStep("provider");
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "keys_check") {
      void (async () => {
        const key = keys[ui.mainIndex - 1];
        if (!key) {
          setMessage("Select a key row first");
          return;
        }
        patchUi({ busy: true });
        const result = await checkApiKey(services, key.id);
        setMessage(
          `${result.status.valid ? "✓" : "✗"} ${key.name}: ${result.status.message}`,
        );
        setKeysVersion((v) => v + 1);
        patchUi({ busy: false });
      })();
      return;
    }

    if (action.type === "keys_check_all") {
      void (async () => {
        patchUi({ busy: true });
        const results = await checkAllApiKeys(services);
        const bad = results.filter((r) => !r.status.valid).length;
        setMessage(
          bad === 0
            ? `✓ ${results.length} keys healthy`
            : `✗ ${bad}/${results.length} failed`,
        );
        setKeysVersion((v) => v + 1);
        patchUi({ busy: false });
      })();
      return;
    }

    if (action.type === "keys_delete") {
      void (async () => {
        const key = keys[ui.mainIndex - 1];
        if (!key) {
          setMessage("Select a key to delete");
          return;
        }
        await services.vault.remove(key.id);
        setKeysVersion((v) => v + 1);
        setMessage(`Deleted ${key.name}`);
      })();
      return;
    }

    if (action.type === "executors_detect") {
      void refreshExecutors().then(() => setMessage("Executors re-detected"));
      return;
    }

    if (action.type === "executors_install") {
      const row = executorRows[ui.mainIndex];
      const plan = row?.installPlan;
      setMessage(
        plan
          ? `Install ${row?.name}: ${plan.command}`
          : "No install plan for selection",
      );
      return;
    }

    if (action.type === "executors_use") {
      const row = executorRows[ui.mainIndex];
      if (!row) {
        setMessage("Select an executor first");
        return;
      }
      setConfig((c) => {
        const next = structuredClone(c);
        next.executor.provider =
          row.id as AssentorConfig["executor"]["provider"];
        return next;
      });
      const installed = row.detection?.installed;
      setMessage(
        installed
          ? `Executor set to ${row.name} — press s in AI defaults to save`
          : `Executor set to ${row.name} (not installed yet) — r to detect, i for install plan`,
      );
      return;
    }

    if (action.type === "cycle_mode") {
      const next = cycleRunMode(config);
      setConfig(next);
      setMessage(
        next.run.mode === "autopilot"
          ? "Mode: Autopilot — executor continues through phases without asking"
          : "Mode: Supervised — executor stops for review between rounds",
      );
      return;
    }

    if (action.type === "cycle_left" || action.type === "cycle_right") {
      const dir = action.type === "cycle_right" ? 1 : -1;
      applyConfigCycle(dir as 1 | -1);
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "save_defaults") {
      void saveConfigDefaults();
      return;
    }

    if (action.type === "jump_screen") {
      const screen = screenAt(action.screenIndex);
      setUi((s) => reduceUi(s, action));
      if (screen === "diagnostics" && diagItems.length === 0) {
        void runDiagnostics();
      }
      if (screen === "tasks") {
        void listProjectTasks(services.projectPath).then(setTasks);
      }
      return;
    }

    if (action.type === "select_nav") {
      const screen = screenAt(ui.navIndex);
      setUi((s) => reduceUi(s, action));
      if (screen === "diagnostics" && diagItems.length === 0) {
        void runDiagnostics();
      }
      if (screen === "tasks") {
        void listProjectTasks(services.projectPath).then(setTasks);
      }
      return;
    }

    setUi((s) => reduceUi(s, action));
  });

  const keyHealthy = keys.filter((k) => k.health === "healthy").length;
  const screenLabel =
    NAV_SCREENS.find((s) => s.id === ui.screen)?.label ?? ui.screen;

  const statusTone =
    updateInfo?.updateAvailable
      ? "warn"
      : ui.busy
        ? "warn"
        : "ok";

  return (
    <Shell
      version={localVersion}
      screen={ui.screen}
      focus={ui.focus}
      navIndex={ui.navIndex}
      statusLabel={ui.busy ? "Busy" : "Ready"}
      statusTone={statusTone}
      message={message}
      busy={ui.busy}
      footer={footerHints(ui)}
      statusBar={{
        projectLabel: shortPath(services.projectPath),
        mode: formatRunMode(config.run.mode),
        executor: config.executor.provider,
        reviewStrategy: config.routing.reviewStrategy,
        model: config.models.default,
        keysHealthy: `${keyHealthy}/${keys.length}`,
        taskLabel: tasks[0]
          ? tasks[0].contract.goal.slice(0, 24)
          : undefined,
      }}
    >
      {ui.dialog === "palette" ? (
        <CommandPalette
          query={paletteQuery}
          commands={paletteCommands}
          selected={ui.mainIndex}
        />
      ) : null}

      {ui.dialog === "help" ? <HelpOverlay screenLabel={screenLabel} /> : null}

      {ui.dialog === "start-task" ? (
        <StartTaskDialog
          step={startTaskStep}
          projectPath={startTaskPath}
          goal={taskPrompt}
          mode={formatRunMode(config.run.mode)}
          executor={formatExecutorProvider(config.executor.provider)}
          explanation={
            reviewPlan && startTaskStep === "confirm"
              ? explainReviewPlan(reviewPlan, config.reviewers)
              : null
          }
        />
      ) : null}

      {ui.dialog === "review-plan" ? (
        <ReviewPlanDialog
          capturing={planCapturing}
          goal={planGoal}
          explanation={reviewPlan ? explainReviewPlan(reviewPlan, config.reviewers) : null}
        />
      ) : null}

      {ui.dialog === "confirm-uninstall" ? (
        <Dialog title="Uninstall Assentor?">
          <MenuList
            items={["Yes, uninstall CLI", "Cancel"]}
            selected={ui.mainIndex}
          />
        </Dialog>
      ) : null}

      {ui.dialog === "confirm-delete-task" ? (
        <Dialog title="Delete this task?">
          <Box flexDirection="column">
            <Text dimColor>
              Removes .assentor/tasks/{pendingDeleteTaskId?.slice(0, 12)}… This
              cannot be undone.
            </Text>
            <MenuList
              items={["Yes, delete task", "Cancel"]}
              selected={ui.mainIndex}
            />
          </Box>
        </Dialog>
      ) : null}

      {ui.dialog === "add-reviewer" ? (
        <AddReviewerDialog
          step={addReviewerStep}
          providers={[...availableReviewerProviders]}
          providerIdx={
            addReviewerStep === "provider"
              ? ui.mainIndex
              : addReviewerProviderIdx
          }
          transports={addReviewerTransports}
          transportIdx={
            addReviewerStep === "transport"
              ? ui.mainIndex
              : addReviewerTransportIdx
          }
          keyLabels={addReviewerKeyChoices.map((c) => c.label)}
          keyIdx={addReviewerStep === "key" ? ui.mainIndex : 0}
        />
      ) : null}

      {ui.dialog === "add-key" ? (
        <KeysScreen
          keys={keys}
          selected={ui.mainIndex}
          focused
          dialog="add-key"
          addStep={addStep}
          addProviderIdx={addProviderIdx}
          addName={addName}
          addSecret={addSecret}
        />
      ) : null}

      {ui.dialog === "none" ? (
        <>
          {ui.screen === "workspace" ? (
            <WorkspaceScreen
              services={services}
              config={config}
              selected={ui.mainIndex}
              tasks={tasks}
              updateInfo={updateInfo}
              keyHealthy={keyHealthy}
              keyTotal={keys.length}
            />
          ) : null}
          {ui.screen === "tasks" ? (
            <TasksScreen
              tasks={tasks}
              selected={ui.mainIndex}
              focused={ui.focus === "main"}
              selectedTaskId={ui.selectedTaskId}
            />
          ) : null}
          {ui.screen === "agents" ? (
            <AgentsScreen
              agents={agents}
              selected={ui.mainIndex}
              focused={ui.focus === "main"}
              prompts={promptList}
              errors={promptLibrary?.errors ? [...promptLibrary.errors] : []}
              loading={promptLibrary === null && promptLoadError === null}
              loadError={promptLoadError}
              preview={promptPreview}
              forkPending={forkPending}
              notice={promptNotice}
            />
          ) : null}
          {ui.screen === "review" ? (
            <ReviewScreen
              config={config}
              selected={ui.mainIndex}
              focused={ui.focus === "main"}
              plan={reviewPlan}
            />
          ) : null}
          {ui.screen === "configuration" ? (
            <ConfigurationScreen
              section={ui.configSection}
              selected={ui.mainIndex}
              focused={ui.focus === "main"}
              config={config}
              keys={keys}
              executorRows={executorRows}
              installedIds={
                new Set(
                  executorRows
                    .filter((row) => row.detection?.installed)
                    .map((row) => row.id),
                )
              }
              envHints={envHints}
            />
          ) : null}
          {ui.screen === "diagnostics" ? (
            <DiagnosticsScreen
              items={diagItems}
              selected={ui.mainIndex}
              focused={ui.focus === "main"}
              busy={ui.busy}
            />
          ) : null}
          {ui.screen === "help" ? <HelpScreen /> : null}
        </>
      ) : null}
    </Shell>
  );
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/** Test and embedding hooks for `startTui`. */
export interface StartTuiOptions {
  /** Opens a prompt file in the editor and resolves with its exit code. Default: `launchEditor`. */
  runEditor?: (file: string) => Promise<number>;
  promptDirs?: PromptDirs;
  /** Ink's `render`. Tests inject a stub; the default is Ink's own. */
  render?: typeof render;
}

export async function startTui(
  projectPath: string,
  options: StartTuiOptions = {},
): Promise<TuiHandoff> {
  const inkStdout = createInkStdout();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  const services = await createAssentorServices(projectPath);
  const initialConfig = await loadAssentorConfig(projectPath);
  let initialUi: Partial<UiState> | undefined;
  let initialNotice: string[] | undefined;
  let initialPromptId: string | undefined;
  for (;;) {
    const { handoff, relaunchArgs } = await renderApp({
      services,
      initialConfig,
      inkStdout,
      initialUi,
      initialNotice,
      initialPromptId,
      promptDirs: options.promptDirs,
      renderFn: options.render ?? render,
    });

    if (relaunchArgs) {
      await relaunchAssentor(relaunchArgs);
      return { kind: "exit" };
    }
    if (handoff.kind !== "edit-prompt") {
      return handoff;
    }

    // The editor ran outside the TUI. Come back on the Agents screen with the
    // edited prompt selected; the reloaded library shows the edit. A prompt file
    // is named after its id, so the basename is the id.
    initialPromptId = path.basename(handoff.file, ".md");
    initialNotice = await openPromptEditor(handoff.file, options.runEditor);
    initialUi = {
      screen: "agents",
      navIndex: NAV_SCREENS.findIndex((screen) => screen.id === "agents"),
    };
  }
}

/** Mount the App once and wait until it exits. The terminal is restored afterwards. */
async function renderApp(input: {
  services: AssentorServices;
  initialConfig: AssentorConfig;
  inkStdout: ReturnType<typeof createInkStdout>;
  initialUi?: Partial<UiState>;
  initialNotice?: string[];
  initialPromptId?: string;
  promptDirs?: PromptDirs;
  renderFn: typeof render;
}): Promise<{ handoff: TuiHandoff; relaunchArgs?: string[] }> {
  let handoff: TuiHandoff = { kind: "exit" };
  let relaunchArgs: string[] | undefined;
  const instance = input.renderFn(
    <App
      services={input.services}
      initialConfig={input.initialConfig}
      initialUi={input.initialUi}
      initialNotice={input.initialNotice}
      initialPromptId={input.initialPromptId}
      promptDirs={input.promptDirs}
      onHandoff={(next) => {
        handoff = next;
        if (next.kind === "relaunch") {
          relaunchArgs = next.args;
        }
        queueMicrotask(() => {
          try {
            instance.unmount();
          } catch {
            // already unmounted
          }
        });
      }}
    />,
    { stdout: input.inkStdout },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    try {
      instance.unmount();
    } catch {
      // already unmounted
    }
    restoreTerminal();
  }
  return { handoff, relaunchArgs };
}

/** Run the editor on `file`. Returns a notice for the next render when it failed, else nothing. */
async function openPromptEditor(
  file: string,
  runEditor: StartTuiOptions["runEditor"],
): Promise<string[] | undefined> {
  // Ink keeps stdin in reading mode while the TUI is mounted. Pause it, so the
  // editor is the only reader of the keyboard. Ink resumes stdin when the App
  // mounts again, because its raw-mode setup adds a reader.
  if (process.stdin.isTTY) {
    process.stdin.pause();
  }
  try {
    const code = await (runEditor ?? launchEditor)(file);
    return code === 0 ? undefined : [`Editor exited with code ${code}.`];
  } catch (error) {
    return [`Could not start the editor: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function restoreTerminal(): void {
  resetTerminalForRelaunch();
}
