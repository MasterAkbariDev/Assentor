#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import {
  doctorAssentor,
  initAssentorProject,
  resumeAssentorTask,
  runAssentorTask,
  statusAssentorTask,
} from "./commands.js";
import { TaskStore } from "../persistence/store.js";
import {
  createAssentorServices,
  runFullDiagnostics,
} from "../services/app.js";
import {
  checkForUpdate,
  getLocalVersionSync,
  readChangelog,
} from "../self/index.js";

const program = new Command();
const version = getLocalVersionSync();

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
  .option("-e, --executor <provider>", "Executor provider (mock|cursor)")
  .option("-r, --reviewer <provider>", "Reviewer provider (mock|openai|gemini)")
  .option("--max-rounds <n>", "Maximum rounds", (v: string) => Number(v))
  .option("--max-messages <n>", "Maximum messages", (v: string) => Number(v))
  .option("-v, --verbose", "Verbose event logging", false)
  .action(
    async (
      promptParts: string[],
      options: {
        project: string;
        executor?: string;
        reviewer?: string;
        maxRounds?: number;
        maxMessages?: number;
        verbose?: boolean;
      },
    ) => {
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error("Provide a task prompt, e.g. assentor run \"Add average()\"");
        process.exitCode = 1;
        return;
      }

      const { result } = await runAssentorTask({
        projectPath: options.project,
        prompt,
        executor: options.executor,
        reviewer: options.reviewer,
        maxRounds: options.maxRounds,
        maxMessages: options.maxMessages,
        verbose: options.verbose,
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
  .option("-v, --verbose", "Verbose event logging", false)
  .action(async (taskId: string | undefined, options: { project: string; verbose?: boolean }) => {
    const result = await resumeAssentorTask({
      projectPath: options.project,
      taskId,
      verbose: options.verbose,
    });
    console.log(`Task ${result.taskId} finished: ${result.status}`);
    if (result.status !== "DONE") {
      process.exitCode = 1;
    }
  });

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
      for (const line of await doctorAssentor()) {
        console.log(line);
      }
      console.log("");
      const { printPreflight, runPreflight } = await import("./preflight.js");
      const result = await runPreflight({
        executor: options.executor,
        reviewer: options.reviewer,
        projectPath: options.project,
      });
      printPreflight(result);
      if (!result.ok) {
        process.exitCode = 1;
      }
    },
  );

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
    const config = await loadAssentorConfig(projectPath);
    console.log(`reviewStrategy: ${config.routing.reviewStrategy}`);
    console.log(`routing: ${config.routing.strategy}`);
    console.log("");
    console.log("Configured transports:");
    for (const reviewer of config.reviewers) {
      console.log(
        `  - ${reviewer.provider}  role=${reviewer.role}  transport=${reviewer.transport ?? "api"}${reviewer.fallback ? `  fallback=${reviewer.fallback.provider}/${reviewer.fallback.transport ?? "api"}` : ""}`,
      );
    }
    console.log("");
    console.log("Logical reviewer profiles:");
    for (const agent of DEFAULT_AGENT_PROFILES.filter(
      (a) => a.kind === "reviewer" || a.kind === "adjudicator",
    )) {
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
  .action(async (options: { project: string }) => {
    const services = await createAssentorServices(path.resolve(options.project));
    const results = await services.executors.detectAll();
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
    console.log(`Local version after update: v${getLocalVersionSync()}`);
    process.exitCode = result.code === 0 ? 0 : 1;
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
