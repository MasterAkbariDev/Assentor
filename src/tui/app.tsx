import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  analyzeReviewPlan,
  checkAllApiKeys,
  checkApiKey,
  createAssentorServices,
  detectExecutor,
  detectExecutors,
  getLocalVersionSync,
  listProjectTasks,
  performUninstall,
  performUpdate,
  performUpdateCheck,
  runFullDiagnostics,
  saveGlobalDefaults,
  type AssentorServices,
  type DiagnosticItem,
} from "../services/app.js";
import { loadAssentorConfig, type AssentorConfig } from "../config/load.js";
import type { UpdateCheckResult } from "../self/index.js";
import type { TaskSnapshot } from "../persistence/store.js";
import type { ComplexityAnalysis } from "../review/complexity.js";
import { Dialog } from "./components/dialog.js";
import { CommandPalette, HelpOverlay } from "./components/overlays.js";
import { Shell } from "./layout/shell.js";
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
  buildDefaultRows,
  CONFIG_MENU,
  ConfigurationScreen,
  cycle,
  DiagnosticsScreen,
  EXECUTOR_OPTIONS,
  type ExecutorRow,
  HelpScreen,
  KEY_PROVIDERS,
  type AddKeyStep,
  KeysScreen,
  MenuList,
  REVIEW_ACTIONS,
  REVIEWER_OPTIONS,
  REVIEW_STRATEGY_OPTIONS,
  ReviewScreen,
  ROUND_OPTIONS,
  ROUTING_OPTIONS,
  TasksScreen,
  WORKSPACE_ACTIONS,
  WorkspaceScreen,
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
  const [diagItems, setDiagItems] = useState<DiagnosticItem[]>([]);
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [executorRows, setExecutorRows] = useState<ExecutorRow[]>([]);
  const [reviewPlan, setReviewPlan] = useState<ComplexityAnalysis | null>(null);

  const [addStep, setAddStep] = useState<AddKeyStep>("provider");
  const [addProviderIdx, setAddProviderIdx] = useState(0);
  const [addName, setAddName] = useState("Personal");
  const [addSecret, setAddSecret] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");

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

  const paletteCommands = useMemo(
    () => filterPaletteCommands(paletteQuery),
    [paletteQuery],
  );

  const mainItemCount = useMemo(() => {
    if (ui.dialog === "palette") return Math.max(paletteCommands.length, 1);
    if (ui.dialog === "add-key") {
      return addStep === "provider" ? KEY_PROVIDERS.length : 1;
    }
    if (ui.dialog === "confirm-uninstall") return 2;
    if (ui.dialog === "ai-defaults") return buildDefaultRows(config).length;
    if (ui.dialog === "review-plan" || ui.dialog === "help") return 1;
    if (ui.dialog === "start-task") return 1;

    switch (ui.screen) {
      case "workspace":
        return WORKSPACE_ACTIONS.length;
      case "tasks":
        return ui.selectedTaskId ? 1 : Math.max(tasks.length, 1);
      case "agents":
        return Math.max(agents.length, 1);
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
    config,
    tasks.length,
    agents.length,
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
    const listed = services.executors.list();
    setExecutorRows(
      listed.map((a) => ({
        id: a.id,
        name: a.name,
        installPlan: a.installPlan?.(),
      })),
    );
    const detected = await detectExecutors(services);
    setExecutorRows(
      detected.map((d) => ({
        id: d.id,
        name: d.name,
        detection: d.detection,
        installPlan: services.executors.get(d.id)?.installPlan?.(),
      })),
    );
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
    patchUi({ busy: true, dialog: "review-plan" });
    setMessage("Analyzing complexity…");
    try {
      const plan = analyzeReviewPlan(
        goal ??
          tasks[0]?.contract.goal ??
          "Review current project changes",
      );
      setReviewPlan(plan);
      setMessage(
        `Score ${plan.score} · ${plan.recommendedCount} reviewers · ${plan.evidenceDepth}`,
      );
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
      patchUi({
        dialog: "start-task",
        capturingText: true,
        focus: "dialog",
        mainIndex: 0,
      });
      return;
    }
    if (cmd.dialog === "review-plan") {
      void openReviewPlan();
      return;
    }
    if (cmd.dialog === "ai-defaults") {
      goScreen("configuration", {
        configSection: "ai",
        dialog: "ai-defaults",
        focus: "dialog",
      });
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

  async function handleActivate() {
    if (ui.dialog === "palette") {
      applyPalette(ui.mainIndex);
      return;
    }

    if (ui.dialog === "help" || ui.dialog === "review-plan") {
      patchUi({ dialog: "none", focus: "main" });
      return;
    }

    if (ui.dialog === "start-task") {
      const prompt = taskPrompt.trim();
      patchUi({ dialog: "none", capturingText: false, focus: "main" });
      if (!prompt) {
        setMessage("Cancelled — empty goal");
        return;
      }
      setMessage(
        `Start via CLI:\nassentor run --project ${services.projectPath} ${JSON.stringify(prompt)}`,
      );
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
      const rows = buildDefaultRows(config);
      const idx = ui.mainIndex;
      if (idx === rows.length - 1) {
        await saveGlobalDefaults(services, config);
        setMessage("Saved defaults to ~/.assentor/config.yaml");
        patchUi({ dialog: "none", focus: "main" });
        return;
      }
      setConfig((c) => cycleDefaultField(c, idx, 1, modelChoices));
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
        patchUi({
          dialog: "start-task",
          capturingText: true,
          focus: "dialog",
        });
      } else if (action?.id === "continue") {
        const latest = tasks.find(
          (t) =>
            t.status !== "DONE" &&
            t.status !== "FAILED" &&
            t.status !== "CANCELLED",
        );
        if (latest) {
          setMessage(
            `Resume: assentor resume ${latest.taskId} --project ${services.projectPath}`,
          );
          goScreen("tasks", { selectedTaskId: latest.taskId });
        } else {
          setMessage("No resumable task — start a new one");
        }
      } else if (action?.id === "review") {
        void openReviewPlan();
      } else if (action?.id === "diagnostics") {
        goScreen("diagnostics");
        void runDiagnostics();
      }
      return;
    }

    if (ui.screen === "tasks") {
      if (ui.selectedTaskId) return;
      const task = tasks[ui.mainIndex];
      if (task) {
        patchUi({ selectedTaskId: task.taskId });
      }
      return;
    }

    if (ui.screen === "review") {
      const action = REVIEW_ACTIONS[ui.mainIndex];
      if (action?.id === "plan") void openReviewPlan();
      if (action?.id === "cli") {
        setMessage('CLI: assentor review "your goal here"');
      }
      if (action?.id === "strategy") {
        goScreen("configuration", {
          configSection: "review",
          dialog: "ai-defaults",
          focus: "dialog",
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
            dialog: "ai-defaults",
            focus: "dialog",
            mainIndex: 0,
          });
        } else {
          patchUi({ configSection: item.id as ConfigSection, mainIndex: 0 });
          if (item.id === "executors") void refreshExecutors();
        }
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
          setMessage(result.output.slice(0, 240));
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
        setUi((s) => reduceUi(s, { type: "escape" }));
        return;
      }
      if (key.return) {
        void handleActivate();
        return;
      }
      if (key.backspace || key.delete) {
        setTaskPrompt((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setTaskPrompt((t) => t + input);
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
      setUi((s) => reduceUi(s, action));
      return;
    }

    if (action.type === "review_plan") {
      void openReviewPlan();
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

    if (action.type === "cycle_left" || action.type === "cycle_right") {
      if (ui.dialog === "ai-defaults") {
        const dir = action.type === "cycle_right" ? 1 : -1;
        setConfig((c) =>
          cycleDefaultField(c, ui.mainIndex, dir as 1 | -1, modelChoices),
        );
      }
      if (ui.dialog === "add-key" && addStep === "provider") {
        // arrows already move mainIndex via reduce
      }
      setUi((s) => reduceUi(s, action));
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
        <Dialog title="Start a task" hint="Describe the goal">
          <Text>
            {taskPrompt || " "}
            <Text color="green">▌</Text>
          </Text>
          <Text dimColor>
            Enter prints the assentor run command (TUI does not spawn agents
            yet).
          </Text>
        </Dialog>
      ) : null}

      {ui.dialog === "review-plan" ? (
        <Dialog title="Review plan" hint="Enter close">
          {reviewPlan ? (
            <Box flexDirection="column">
              <Text>
                Score {reviewPlan.score}/100 · risk {reviewPlan.risk} · depth{" "}
                {reviewPlan.evidenceDepth}
              </Text>
              <Text>
                Assentor recommends {reviewPlan.recommendedCount} reviewers:{" "}
                {reviewPlan.recommendedRoles.join(", ")}
              </Text>
              {reviewPlan.signals.slice(0, 6).map((s) => (
                <Text key={s} dimColor>
                  • {s}
                </Text>
              ))}
              <Text dimColor>
                Accept via routing.reviewStrategy=
                {config.routing.reviewStrategy} on assentor run
              </Text>
            </Box>
          ) : (
            <Text dimColor>Analyzing…</Text>
          )}
        </Dialog>
      ) : null}

      {ui.dialog === "ai-defaults" ? (
        <Dialog title="AI defaults" hint="←→ cycle · Enter save on last row">
          <MenuList items={buildDefaultRows(config)} selected={ui.mainIndex} />
        </Dialog>
      ) : null}

      {ui.dialog === "confirm-uninstall" ? (
        <Dialog title="Uninstall Assentor?">
          <MenuList
            items={["Yes, uninstall CLI", "Cancel"]}
            selected={ui.mainIndex}
          />
        </Dialog>
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

function cycleDefaultField(
  config: AssentorConfig,
  idx: number,
  dir: 1 | -1,
  modelChoices: string[],
): AssentorConfig {
  const next = { ...config };
  switch (idx) {
    case 0:
      next.executor = {
        ...next.executor,
        provider: cycle(EXECUTOR_OPTIONS, next.executor.provider, dir),
      };
      break;
    case 1: {
      const provider = cycle(
        REVIEWER_OPTIONS,
        (next.reviewers[0]?.provider ?? "mock") as (typeof REVIEWER_OPTIONS)[number],
        dir,
      );
      next.reviewers = [
        {
          provider,
          role: next.reviewers[0]?.role ?? "general",
          transport: next.reviewers[0]?.transport ?? "api",
        },
      ];
      break;
    }
    case 2:
      next.routing = {
        ...next.routing,
        strategy: cycle(ROUTING_OPTIONS, next.routing.strategy, dir),
      };
      break;
    case 3:
      next.routing = {
        ...next.routing,
        reviewStrategy: cycle(
          REVIEW_STRATEGY_OPTIONS,
          next.routing.reviewStrategy,
          dir,
        ),
      };
      break;
    case 4:
      next.models = {
        ...next.models,
        default: cycle(modelChoices, next.models.default, dir),
      };
      break;
    case 5:
      next.models = {
        ...next.models,
        gemini: cycle(modelChoices, next.models.gemini, dir),
      };
      break;
    case 6:
      next.models = {
        ...next.models,
        openai: cycle(modelChoices, next.models.openai, dir),
      };
      break;
    case 7:
      next.limits = {
        ...next.limits,
        maxRounds: cycle(ROUND_OPTIONS, next.limits.maxRounds as (typeof ROUND_OPTIONS)[number], dir),
      };
      break;
    default:
      break;
  }
  return next;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

export async function startTui(projectPath: string): Promise<void> {
  const services = await createAssentorServices(projectPath);
  const initialConfig = await loadAssentorConfig(projectPath);
  const instance = render(
    <App services={services} initialConfig={initialConfig} />,
  );
  await instance.waitUntilExit();
}
