#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import path from "node:path";
import {
  doctorAssentor,
  initAssentorProject,
  parseModeFlags,
  resumeAssentorTask,
  runAssentorTask,
  statusAssentorTask,
} from "./commands.js";
import { TaskStore } from "../persistence/store.js";
import {
  editPrompt,
  forkPrompt,
  listPrompts,
  showPrompt,
  validatePrompts,
} from "./prompts.js";
import {
  createAssentorServices,
  runFullDiagnostics,
} from "../services/app.js";
import {
  checkForUpdate,
  getLocalVersionSync,
  readChangelog,
  runAssentorSubcommand,
} from "../self/index.js";

const program = new Command();
const version = getLocalVersionSync();

/** Commander turns a thrown InvalidArgumentError into a one-line message and exit code 1. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65_535) {
    throw new InvalidArgumentError("Port must be an integer from 0 to 65535.");
  }
  return port;
}

program
  .name("assentor")
  .description("AI agent orchestrator for software development tasks")
  .version(version);

program
  .command("ui")
  .description("Launch interactive terminal UI")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const { startTui } = await import("../tui/index.js");
    const handoff = await startTui(path.resolve(options.project));
    if (handoff.kind === "run") {
      const { result } = await runAssentorTask({
        projectPath: handoff.projectPath,
        prompt: handoff.prompt,
        executor: handoff.executor,
        autonomy: handoff.autonomy,
      });
      console.log(`Task ${result.taskId} finished: ${result.status}`);
      if (result.status !== "DONE") process.exitCode = 1;
    } else if (handoff.kind === "resume") {
      const result = await resumeAssentorTask({
        projectPath: handoff.projectPath,
        taskId: handoff.taskId,
      });
      console.log(`Task ${result.taskId} finished: ${result.status}`);
      if (result.status !== "DONE") process.exitCode = 1;
    }
  });

program
  .command("serve")
  .description("Serve the web UI and a read-only engine API on this machine (watch runs live)")
  .option("-p, --project <path>", "Project directory", ".")
  .option("--port <n>", "Port (0 picks a free one)", (v: string) => Number(v), 4319)
  .option("--host <address>", "Address to listen on", "127.0.0.1")
  .option("--unsafe-listen", "Allow a non-loopback --host (anyone with the token could read your sessions)", false)
  .option("--idle-timeout <minutes>", "Stop after this many minutes with no browser connected", (v: string) => Number(v))
  .action(
    async (options: {
      project: string;
      port: number;
      host: string;
      unsafeListen: boolean;
      idleTimeout?: number;
    }) => {
      const { startServe } = await import("../serve/index.js");
      const handle = await startServe({
        projectPath: path.resolve(options.project),
        port: options.port,
        host: options.host,
        unsafeListen: options.unsafeListen,
        ...(options.idleTimeout ? { idleTimeoutMs: options.idleTimeout * 60_000 } : {}),
      });
      // The only place the token is shown: the user needs it to open the UI.
      console.log(`Assentor is serving ${path.resolve(options.project)}`);
      console.log(`Open: ${handle.url}`);
      console.log("Read-only. Press Ctrl+C to stop.");
      const stop = () => void handle.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await handle.closed;
    },
  );

program
  .command("app")
  .description("Serve the web UI on a free local port and open it in your browser")
  .option("-p, --project <path>", "Project directory", ".")
  .option("--port <n>", "Port (0 picks a free one)", parsePort, 0)
  .option("--no-open", "Print the URL without opening a browser")
  .action(async (options: { project: string; port: number; open: boolean }) => {
    const { runApp } = await import("./app.js");
    await runApp({
      projectPath: path.resolve(options.project),
      port: options.port,
      open: options.open,
    });
  });

program
  .command("export")
  .description("Write a Markdown report of a session from its event log")
  .argument("<sessionId>", "Session id")
  .option("-p, --project <path>", "Project directory", ".")
  .option("-o, --out <file>", "Write the report to this file instead of stdout")
  .option("--force", "Replace the --out file if it already exists", false)
  .action(async (sessionId: string, options: { project: string; out?: string; force: boolean }) => {
    const { readSessionEvents } = await import("../events/index.js");
    const { renderSessionReport, saveSessionReport } = await import("../export/index.js");
    try {
      const projectPath = path.resolve(options.project);
      const events = await readSessionEvents(projectPath, sessionId);
      if (events.length === 0) {
        throw new Error(`No events found for session ${sessionId} in ${projectPath}`);
      }
      const report = renderSessionReport(events);
      if (options.out) {
        const file = path.resolve(options.out);
        await saveSessionReport(file, report, { force: options.force });
        console.log(`Wrote ${file}`);
      } else {
        process.stdout.write(report);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description(
    "Create an optional project .assentor/config.yaml override (global defaults live in ~/.assentor)",
  )
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const configPath = await initAssentorProject(options.project);
    console.log(`Initialized Assentor config at ${configPath}`);
  });

program
  .command("run")
  .description("Run an orchestrated development task")
  .argument("[prompt...]", "Task prompt")
  .option("-p, --project <path>", "Project directory", ".")
  .option(
    "-e, --executor <provider>",
    "Executor (mock|cursor|claude-code|antigravity|codex|qwen|opencode)",
  )
  .option(
    "--executor-model <model>",
    "Model for the executor CLI (overrides config executor.model)",
  )
  .option("-r, --reviewer <provider>", "Reviewer provider (mock|openai|gemini)")
  .option("--team <name>", "Review with this configured team (overrides modes.review.team)")
  .option("--max-rounds <n>", "Maximum rounds", (v: string) => Number(v))
  .option("--max-messages <n>", "Maximum messages", (v: string) => Number(v))
  .option("-v, --verbose", "Verbose event logging", false)
  .option("--skip-gates", "Skip deterministic pre-review verification", false)
  .option(
    "--mode <mode>",
    "Session mode (solo; more coming). supervised|autopilot still work but are deprecated: use --autonomy",
  )
  .option("--autonomy <level>", "How much runs without asking: manual|supervised|autopilot")
  .option("--autopilot", "Shortcut for --autonomy autopilot (auto next-phase)", false)
  .action(
    async (
      promptParts: string[],
      options: {
        project: string;
        executor?: string;
        executorModel?: string;
        reviewer?: string;
        team?: string;
        maxRounds?: number;
        maxMessages?: number;
        verbose?: boolean;
        skipGates?: boolean;
        mode?: string;
        autonomy?: string;
        autopilot?: boolean;
      },
    ) => {
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error("Provide a task prompt, e.g. assentor run \"Add average()\"");
        process.exitCode = 1;
        return;
      }

      const flags = parseModeFlags(options);
      if (flags.notice) console.error(flags.notice);

      const { result } = await runAssentorTask({
        projectPath: options.project,
        prompt,
        executor: options.executor,
        executorModel: options.executorModel,
        reviewer: options.reviewer,
        team: options.team,
        maxRounds: options.maxRounds,
        maxMessages: options.maxMessages,
        verbose: options.verbose,
        skipGates: options.skipGates,
        autonomy: flags.autonomy,
        modeId: flags.modeId,
      });

      console.log(`Task ${result.taskId} finished: ${result.status}`);
      if (result.reason) {
        console.log(`Reason: ${result.reason}`);
      }
      if (result.status !== "DONE") {
        process.exitCode = 1;
      }
    },
  );

program
  .command("resume")
  .description("Resume a previously interrupted, failed, or timed-out task")
  .argument("[task-id]", "Task id (omit to resume the latest in this project)")
  .option("-p, --project <path>", "Project directory", ".")
  .option(
    "-e, --executor <provider>",
    "Executor override (mock|cursor|claude-code|antigravity|codex|qwen|opencode)",
  )
  .option(
    "-r, --reviewer <provider>",
    "Reviewer override (mock|openai|gemini|claude|antigravity|cursor)",
  )
  .option("-v, --verbose", "Verbose event logging", false)
  .option("--max-rounds <n>", "Raise round budget for this resume", (v: string) =>
    Number(v),
  )
  .option("--max-messages <n>", "Raise message budget for this resume", (v: string) =>
    Number(v),
  )
  .option(
    "--executor-model <model>",
    "Model for the executor CLI (overrides config executor.model)",
  )
  .option("--team <name>", "Review with this configured team (overrides modes.review.team)")
  .option("--autonomy <level>", "How much runs without asking: manual|supervised|autopilot")
  .action(
    async (
      taskId: string | undefined,
      options: {
        project: string;
        executor?: string;
        reviewer?: string;
        verbose?: boolean;
        maxRounds?: number;
        maxMessages?: number;
        executorModel?: string;
        team?: string;
        autonomy?: string;
      },
    ) => {
    const { autonomy } = parseModeFlags({ autonomy: options.autonomy });
    const result = await resumeAssentorTask({
      projectPath: options.project,
      taskId,
      executor: options.executor,
      reviewer: options.reviewer,
      verbose: options.verbose,
      maxRounds: options.maxRounds,
      maxMessages: options.maxMessages,
      executorModel: options.executorModel,
      team: options.team,
      autonomy,
    });
      console.log(`Task ${result.taskId} finished: ${result.status}`);
      if (result.status !== "DONE") {
        process.exitCode = 1;
      }
    },
  );

program
  .command("status")
  .description("Show persisted task status")
  .argument("<task-id>", "Task id")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (taskId: string, options: { project: string }) => {
    const snapshot = await statusAssentorTask(options.project, taskId);
    console.log(JSON.stringify(snapshot, null, 2));
  });

program
  .command("logs")
  .description("Show persisted task events")
  .argument("<task-id>", "Task id")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (taskId: string, options: { project: string }) => {
    const store = await TaskStore.open(path.resolve(options.project), taskId);
    const events = await store.loadEvents();
    for (const event of events) {
      console.log(`${event.at} ${event.type}`);
    }
  });

program
  .command("doctor")
  .description("Check local environment for Assentor")
  .option("--executor <provider>", "Also probe this executor", "cursor")
  .option("--reviewer <provider>", "Also probe this reviewer", "gemini")
  .option("-p, --project <path>", "Project directory to trust/probe", ".")
  .action(
    async (options: {
      executor: string;
      reviewer: string;
      project: string;
    }) => {
      for (const line of await doctorAssentor({ projectPath: options.project })) {
        console.log(line);
      }
      console.log("");
      const { printPreflight, runPreflight } = await import("./preflight.js");
      const { defaultTransportForProvider } = await import(
        "../review/backends.js"
      );
      const result = await runPreflight({
        executor: options.executor,
        reviewers: [
          {
            provider: options.reviewer,
            transport: defaultTransportForProvider(options.reviewer),
          },
        ],
        projectPath: options.project,
        probeCursor: true,
      });
      printPreflight(result);
      if (!result.ok) {
        process.exitCode = 1;
      }
    },
  );

const promptIo = {
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
};

const promptsCmd = program
  .command("prompts")
  .description("List, show, fork, edit and validate prompts");

promptsCmd
  .command("list")
  .description("List prompts with their layer and whether they override a lower layer")
  .option("-p, --project <path>", "Project directory", ".")
  .option("--role <role>", "Only this role (builder|reviewer|meta)")
  .action(async (options: { project: string; role?: string }) => {
    process.exitCode = await listPrompts({ projectPath: options.project, role: options.role, ...promptIo });
  });

promptsCmd
  .command("show")
  .description("Show a prompt's front-matter and body")
  .argument("<id>", "Prompt id")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (id: string, options: { project: string }) => {
    process.exitCode = await showPrompt({ projectPath: options.project, id, ...promptIo });
  });

promptsCmd
  .command("fork")
  .description("Copy a prompt into the user or project layer so you can change it")
  .argument("<id>", "Prompt id to copy")
  .option("-p, --project <path>", "Project directory", ".")
  .option("--to <layer>", "Where the copy goes: user or project", "user")
  .option("--as <newId>", "Give the copy a different id")
  .action(async (id: string, options: { project: string; to: string; as?: string }) => {
    process.exitCode = await forkPrompt({
      projectPath: options.project,
      id,
      to: options.to,
      as: options.as,
      ...promptIo,
    });
  });

promptsCmd
  .command("edit")
  .description("Open the project or user copy of a prompt in $VISUAL, $EDITOR, or a fallback editor")
  .argument("<id>", "Prompt id")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (id: string, options: { project: string }) => {
    process.exitCode = await editPrompt({ projectPath: options.project, id, ...promptIo });
  });

promptsCmd
  .command("validate")
  .description("Check every prompt file and report load errors")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    process.exitCode = await validatePrompts({ projectPath: options.project, ...promptIo });
  });

const keysCmd = program.command("keys").description("Manage API keys");

keysCmd
  .command("list")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    for (const key of services.vault.list()) {
      console.log(
        `${key.id.slice(0, 8)}  ${key.provider.padEnd(12)} ${key.name.padEnd(20)} ${key.masked}  ${key.health}  ${key.enabled ? "on" : "off"}`,
      );
    }
  });

keysCmd
  .command("add")
  .requiredOption("--provider <id>", "Provider id")
  .requiredOption("--name <name>", "Key label")
  .requiredOption("--secret <secret>", "API key secret")
  .option("-p, --project <path>", "Project directory", ".")
  .action(
    async (options: {
      provider: string;
      name: string;
      secret: string;
      project: string;
    }) => {
      const services = await createAssentorServices(
        path.resolve(options.project),
      );
      const key = await services.vault.add({
        provider: options.provider,
        name: options.name,
        secret: options.secret,
      });
      console.log(`Added ${key.name} (${key.masked})`);
    },
  );

keysCmd
  .command("check")
  .argument("[key-id]", "Key id (omit with --all)")
  .option("--all", "Check all enabled keys", false)
  .option("-p, --project <path>", "Project directory", ".")
  .action(
    async (
      keyId: string | undefined,
      options: { all?: boolean; project: string },
    ) => {
      const services = await createAssentorServices(
        path.resolve(options.project),
      );
      if (options.all) {
        const results = await services.vault.checkAll((id) =>
          services.providers.get(id),
        );
        for (const result of results) {
          const mark = result.status.valid ? "✓" : "✗";
          console.log(
            `${mark} ${result.key.name}: ${result.status.message}`,
          );
        }
        return;
      }
      if (!keyId) {
        console.error("Provide a key id or --all");
        process.exitCode = 1;
        return;
      }
      const key = services.vault.get(keyId) ??
        services.vault.list().find((k) => k.id.startsWith(keyId));
      if (!key) {
        console.error("Key not found");
        process.exitCode = 1;
        return;
      }
      const provider = services.providers.get(key.provider);
      if (!provider) {
        console.error("Unknown provider");
        process.exitCode = 1;
        return;
      }
      const { status } = await services.vault.checkKey(key.id, provider);
      console.log(status.valid ? "✓ HEALTHY" : "✗ FAILED");
      console.log(status.message);
      if (!status.valid) process.exitCode = 1;
    },
  );

keysCmd
  .command("dedupe")
  .description("Remove duplicate vault keys (same provider, name, masked secret)")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    const before = services.vault.list().length;
    await services.vault.load();
    const after = services.vault.list().length;
    console.log(`Vault deduped: ${before} → ${after} key(s)`);
  });

keysCmd
  .command("delete")
  .argument("<key-id>", "Key id (prefix match ok)")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (keyId: string, options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    const key =
      services.vault.get(keyId) ??
      services.vault.list().find((k) => k.id.startsWith(keyId));
    if (!key) {
      console.error("Key not found");
      process.exitCode = 1;
      return;
    }
    const removed = await services.vault.remove(key.id);
    console.log(removed ? `Deleted ${key.name}` : "Nothing deleted");
  });

keysCmd
  .command("providers")
  .description("List key providers Assentor knows about")
  .action(() => {
    for (const id of ["gemini", "openai", "openrouter", "qwen"]) {
      console.log(id);
    }
  });

program
  .command("reviewers")
  .description("List configured / logical reviewers and review strategy")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const projectPath = path.resolve(options.project);
    const { loadAssentorConfig } = await import("../config/load.js");
    const { DEFAULT_AGENT_PROFILES } = await import("../agents/index.js");
    const { isCliReviewerAvailable } = await import(
      "../providers/reviewers/cli/index.js"
    );
    const config = await loadAssentorConfig(projectPath);
    console.log(`reviewStrategy: ${config.routing.reviewStrategy}`);
    console.log(`routing: ${config.routing.strategy}`);
    console.log("");
    console.log("Configured transports:");
    for (const reviewer of config.reviewers) {
      if (reviewer.transport === "cli" && !isCliReviewerAvailable(reviewer.provider)) {
        continue;
      }
      console.log(
        `  - ${reviewer.provider}  role=${reviewer.role}  transport=${reviewer.transport ?? "api"}${reviewer.fallback ? `  fallback=${reviewer.fallback.provider}/${reviewer.fallback.transport ?? "api"}` : ""}`,
      );
    }
    console.log("");
    console.log("Logical reviewer profiles:");
    for (const agent of DEFAULT_AGENT_PROFILES.filter(
      (a) => a.kind === "reviewer" || a.kind === "adjudicator",
    )) {
      if (agent.transport === "cli" && !isCliReviewerAvailable(agent.provider)) {
        continue;
      }
      console.log(
        `  ${agent.id.padEnd(24)} ${(agent.specialty ?? "-").padEnd(14)} ${agent.enabled ? "on" : "off"}  transport=${agent.transport ?? "api"}`,
      );
    }
  });

program
  .command("review")
  .description("Analyze a task for review plan (complexity, roles, evidence depth)")
  .argument("[prompt...]", "Task prompt to analyze")
  .option("-p, --project <path>", "Project directory", ".")
  .option("--json", "Emit JSON", false)
  .action(
    async (
      promptParts: string[],
      options: { project: string; json?: boolean },
    ) => {
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error(
          'Provide a task prompt, e.g. assentor review "Refactor auth module"',
        );
        process.exitCode = 1;
        return;
      }
      const projectPath = path.resolve(options.project);
      const { loadAssentorConfig } = await import("../config/load.js");
      const { TaskComplexityAnalyzer, EvidencePackBuilder } = await import(
        "../review/index.js"
      );
      const { selectReviewers, DEFAULT_AGENT_PROFILES } = await import(
        "../agents/index.js"
      );
      const config = await loadAssentorConfig(projectPath);
      let overview;
      try {
        const pack = await new EvidencePackBuilder({
          projectPath,
          depth: "QUICK",
          runCommands: false,
        }).build();
        overview = {
          projectType: pack.overview.projectType,
          framework: pack.overview.framework,
          packageManager: pack.overview.packageManager,
          hasTests: Boolean(pack.overview.testFramework),
        };
      } catch {
        overview = undefined;
      }
      const analysis = new TaskComplexityAnalyzer().analyze({
        taskText: prompt,
        projectOverview: overview,
      });
      const selected = selectReviewers(
        DEFAULT_AGENT_PROFILES,
        config.routing.reviewStrategy,
        prompt,
        { min: 1, max: analysis.recommendedCount },
      );
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              prompt,
              strategy: config.routing.reviewStrategy,
              analysis,
              selectedReviewers: selected.map((s) => ({
                id: s.id,
                specialty: s.specialty,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Task: ${prompt}`);
      console.log(
        `Complexity: ${analysis.score}/100 · risk=${analysis.risk} · depth=${analysis.evidenceDepth}`,
      );
      console.log(`Strategy: ${config.routing.reviewStrategy}`);
      console.log(
        `Recommended roles (${analysis.recommendedCount}): ${analysis.recommendedRoles.join(", ")}`,
      );
      console.log(
        `Selected: ${selected.map((s) => s.id).join(", ") || "(none)"}`,
      );
      if (analysis.signals.length) {
        console.log("Signals:");
        for (const signal of analysis.signals.slice(0, 12)) {
          console.log(`  - ${signal}`);
        }
      }
    },
  );

program
  .command("executors")
  .description("Detect installed coding-agent CLIs")
  .option("-p, --project <path>", "Project directory", ".")
  .option("-a, --all", "Include unavailable/uninstalled CLIs", false)
  .action(async (options: { project: string; all?: boolean }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    const allResults = await services.executors.detectAll();
    const results = options.all
      ? allResults
      : allResults.filter((r) => r.detection.installed);
    if (results.length === 0) {
      console.log("No installed coding-agent CLIs found.");
      return;
    }
    for (const result of results) {
      const mark = result.detection.installed ? "✓" : "✗";
      console.log(
        `${mark} ${result.name}: ${result.detection.installed ? result.detection.path : result.detection.error}`,
      );
      const adapter = services.executors.get(result.id);
      const plan = adapter?.installPlan?.();
      if (!result.detection.installed && plan) {
        console.log(`    install: ${plan.command}`);
      }
    }
  });

program
  .command("diagnostics")
  .description("Run full Assentor diagnostics")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    const items = await runFullDiagnostics(services);
    for (const item of items) {
      console.log(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`);
    }
    if (items.some((i) => !i.ok)) process.exitCode = 1;
  });

program
  .command("agents")
  .description("List logical agents")
  .option("-p, --project <path>", "Project directory", ".")
  .action(async (options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    for (const agent of services.agents.list()) {
      console.log(
        `${agent.id.padEnd(24)} ${agent.kind.padEnd(12)} ${agent.provider}/${agent.model}  ${agent.enabled ? "on" : "off"}`,
      );
    }
  });

program
  .command("update")
  .description("Update Assentor (pull latest + rebuild, or re-run installer)")
  .action(async () => {
    const { updateAssentor } = await import("../self/index.js");
    const check = await checkForUpdate({ force: true });
    if (check.updateAvailable) {
      console.log(check.message);
    } else if (check.latest) {
      console.log(`Already on latest (v${check.local}). Rebuilding…`);
    } else {
      console.log(check.message);
    }
    const result = await updateAssentor();
    console.log(result.output);
    if (result.code !== 0) {
      process.exitCode = 1;
      return;
    }
    const verified = await runAssentorSubcommand(["version"]);
    const versionLine =
      verified.stdout.trim().split("\n").find(Boolean) ??
      `assentor v${getLocalVersionSync()}`;
    console.log(`Reloaded: ${versionLine}`);
    if (verified.stderr.trim()) {
      console.error(verified.stderr.trim());
    }
    process.exitCode = verified.code === 0 ? 0 : verified.code ?? 1;
  });

program
  .command("uninstall")
  .description("Remove the assentor CLI symlink (project data kept)")
  .option("--purge", "Also remove managed ~/.assentor install", false)
  .action(async (options: { purge?: boolean }) => {
    const { uninstallAssentor } = await import("../self/index.js");
    const result = await uninstallAssentor({ purge: Boolean(options.purge) });
    console.log(result.output);
    process.exitCode = result.code === 0 ? 0 : 1;
  });

program
  .command("version")
  .description("Show Assentor version and optionally check for updates")
  .option("--check", "Check GitHub for a newer release", false)
  .action(async (options: { check?: boolean }) => {
    console.log(`assentor v${getLocalVersionSync()}`);
    if (!options.check) {
      console.log("Tip: assentor version --check");
      return;
    }
    const result = await checkForUpdate({ force: true });
    console.log(result.message);
    if (result.latest) {
      console.log(`latest: v${result.latest} (${result.source})`);
    }
    if (result.updateAvailable) {
      console.log(`Changelog: ${result.changelogUrl}`);
      console.log("Run: assentor update");
      process.exitCode = 0;
    }
  });

program
  .command("changelog")
  .description("Print the local CHANGELOG.md")
  .action(async () => {
    try {
      console.log(await readChangelog());
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
  });

// Default to TUI when no args
if (process.argv.length <= 2) {
  process.argv.push("ui");
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
