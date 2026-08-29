import { AgentRegistry } from "../agents/index.js";
import type { AssentorConfig } from "../config/load.js";
import { saveAssentorConfig } from "../config/load.js";
import { userAssentorProjectRoot } from "../config/paths.js";
import {
  buildExecutorRegistry,
  type DetectionResult,
  type InstallPlan,
} from "../executors/index.js";
import { KeyVault, type StoredApiKey } from "../keys/index.js";
import {
  AUTO_SEEDED_KEY_NAMES,
  listEnvKeyPresence,
} from "../keys/resolve.js";
import type { KeyStatus } from "../providers/ai/types.js";
import { createSeededModelRegistry } from "../models/index.js";
import { TaskStore, type TaskSnapshot } from "../persistence/store.js";
import {
  createDefaultProviderRegistry,
  type AIProvider,
} from "../providers/ai/index.js";
import {
  TaskComplexityAnalyzer,
  type ComplexityAnalysis,
  type ProjectOverviewSignals,
} from "../review/complexity.js";
import { RoutingEngine } from "../routing/index.js";
import {
  checkForUpdate,
  getLocalVersionSync,
  relaunchAssentor,
  uninstallAssentor,
  updateAssentor,
  type UpdateCheckResult,
} from "../self/index.js";
import { AuditLog, type AuditEvent } from "./audit.js";
import path from "node:path";

export interface AssentorServices {
  /** Workspace used for `assentor run` / Cursor (cwd or --project). */
  projectPath: string;
  /** Always the user home root so keys/agents live in ~/.assentor. */
  userRoot: string;
  providers: Map<string, AIProvider>;
  models: ReturnType<typeof createSeededModelRegistry>;
  vault: KeyVault;
  agents: AgentRegistry;
  executors: ReturnType<typeof buildExecutorRegistry>;
  routing: RoutingEngine;
  audit: AuditLog;
}

/**
 * Shared services for TUI / keys / diagnostics.
 * Vault, agents, and audit always use the user data root (~/.assentor),
 * so opening the menu in a random folder does not create a local .assentor.
 */
export async function createAssentorServices(
  projectPath: string,
  options: { userRoot?: string } = {},
): Promise<AssentorServices> {
  const userRoot = options.userRoot ?? userAssentorProjectRoot();
  const resolvedProject = path.resolve(projectPath);

  const providers = createDefaultProviderRegistry();
  const models = createSeededModelRegistry({ providers });
  const vault = new KeyVault(userRoot);
  await vault.load();
  await pruneAutoSeededEnvKeys(vault);

  const agents = new AgentRegistry(userRoot);
  await agents.load();

  const executors = buildExecutorRegistry();
  const audit = new AuditLog(userRoot);
  const routing = new RoutingEngine({
    providers,
    models,
    vault,
    onDecision: (decision) => {
      void audit.append("routing.decision", `Routed ${decision.agentId}`, {
        ...decision,
      });
    },
  });

  return {
    projectPath: resolvedProject,
    userRoot,
    providers,
    models,
    vault,
    agents,
    executors,
    routing,
    audit,
  };
}

async function pruneAutoSeededEnvKeys(vault: KeyVault): Promise<void> {
  const names = new Set<string>(AUTO_SEEDED_KEY_NAMES);
  for (const key of vault.list()) {
    if (names.has(key.name)) {
      await vault.remove(key.id);
    }
  }
}

export interface DiagnosticItem {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runFullDiagnostics(
  services: AssentorServices,
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];

  const envHints = listEnvKeyPresence();

  for (const provider of services.providers.values()) {
    const keys = services.vault.list(provider.id).filter((k) => k.enabled);
    const env = envHints.find((e) => e.provider === provider.id);
    if (keys.length === 0) {
      if (env) {
        items.push({
          name: `provider:${provider.id}`,
          ok: true,
          detail: `from $${env.envName} (not stored in vault)`,
        });
      } else {
        items.push({
          name: `provider:${provider.id}`,
          ok: false,
          detail: "No API keys configured (user vault ~/.assentor)",
        });
      }
      continue;
    }
    items.push({
      name: `provider:${provider.id}`,
      ok: true,
      detail: `${keys.length} key(s), ${keys.filter((k) => k.health === "healthy").length} healthy`,
    });
  }

  for (const key of services.vault.list()) {
    const provider = services.providers.get(key.provider);
    if (!provider) {
      items.push({
        name: `key:${key.name}`,
        ok: false,
        detail: "Unknown provider",
      });
      continue;
    }
    const { status } = await services.vault.checkKey(key.id, provider);
    items.push({
      name: `key:${key.name}`,
      ok: status.valid,
      detail: status.message,
    });
    await services.audit.append(
      "key.checked",
      `${key.name}: ${status.message}`,
      { keyId: key.id, valid: status.valid },
    );
  }

  const detections = await services.executors.detectAll();
  for (const det of detections) {
    items.push({
      name: `executor:${det.id}`,
      ok: det.detection.installed,
      detail: det.detection.installed
        ? `Installed at ${det.detection.path ?? "?"}`
        : det.detection.error ?? "Not installed",
    });
  }

  return items;
}

export async function checkApiKey(
  services: AssentorServices,
  keyId: string,
): Promise<{ key: StoredApiKey; status: KeyStatus }> {
  const providerId = services.vault.get(keyId)?.provider;
  if (!providerId) {
    throw new Error(`Key not found: ${keyId}`);
  }
  const provider = services.providers.get(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  const result = await services.vault.checkKey(keyId, provider);
  await services.audit.append(
    "key.checked",
    `${result.key.name}: ${result.status.message}`,
    { keyId, valid: result.status.valid },
  );
  return result;
}

export async function checkAllApiKeys(
  services: AssentorServices,
): Promise<Array<{ key: StoredApiKey; status: KeyStatus }>> {
  const results = await services.vault.checkAll((id) =>
    services.providers.get(id),
  );
  for (const r of results) {
    await services.audit.append(
      "key.checked",
      `${r.key.name}: ${r.status.message}`,
      { keyId: r.key.id, valid: r.status.valid },
    );
  }
  return results;
}

export async function detectExecutors(
  services: AssentorServices,
): Promise<
  Array<{ id: string; name: string; detection: DetectionResult }>
> {
  return services.executors.detectAll();
}

export function getExecutorInstallPlan(
  services: AssentorServices,
  executorId: string,
): InstallPlan | undefined {
  return services.executors.get(executorId)?.installPlan?.();
}

export async function detectExecutor(
  services: AssentorServices,
  executorId: string,
): Promise<{
  id: string;
  name: string;
  detection: DetectionResult;
  installPlan?: InstallPlan;
}> {
  const adapter = services.executors.get(executorId);
  if (!adapter) {
    throw new Error(`Unknown executor: ${executorId}`);
  }
  const detection = await adapter.detect();
  return {
    id: adapter.id,
    name: adapter.name,
    detection,
    installPlan: adapter.installPlan?.(),
  };
}

export function analyzeReviewPlan(
  taskText: string,
  projectOverview?: ProjectOverviewSignals,
): ComplexityAnalysis {
  return new TaskComplexityAnalyzer().analyze({
    taskText,
    projectOverview,
  });
}

export async function listProjectTasks(
  projectPath: string,
): Promise<TaskSnapshot[]> {
  const ids = await TaskStore.list(projectPath);
  const snaps: TaskSnapshot[] = [];
  for (const id of ids) {
    try {
      const store = await TaskStore.open(projectPath, id);
      snaps.push(await store.loadSnapshot());
    } catch {
      // skip corrupt / partial task dirs
    }
  }
  snaps.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  return snaps;
}

export async function deleteProjectTask(
  projectPath: string,
  taskId: string,
): Promise<void> {
  await TaskStore.remove(projectPath, taskId);
}

export async function loadAuditEvents(
  services: AssentorServices,
  limit = 40,
): Promise<AuditEvent[]> {
  return services.audit.list(limit);
}

export async function saveGlobalDefaults(
  services: AssentorServices,
  config: AssentorConfig,
): Promise<string> {
  const saved = await saveAssentorConfig(services.projectPath, config, {
    scope: "user",
  });
  await services.audit.append(
    "agent.updated",
    "Updated global run defaults from TUI",
    {
      executor: config.executor.provider,
      reviewer: config.reviewers
        .map((r) => `${r.provider}/${r.transport}`)
        .join(", "),
      routing: config.routing.strategy,
    },
  );
  return saved;
}

export async function performUpdateCheck(
  force = false,
): Promise<UpdateCheckResult> {
  return checkForUpdate({ force });
}

export async function performUpdate(options?: {
  relaunchArgs?: string[];
}): Promise<{
  code: number;
  output: string;
  localVersion: string;
  relaunched?: boolean;
}> {
  const result = await updateAssentor();
  const localVersion = getLocalVersionSync();
  if (result.code === 0 && options?.relaunchArgs) {
    await relaunchAssentor(options.relaunchArgs);
    return {
      code: result.code,
      output: result.output,
      localVersion,
      relaunched: true,
    };
  }
  return {
    code: result.code,
    output: result.output,
    localVersion,
  };
}

export async function performUninstall(options?: {
  purge?: boolean;
}): Promise<{ code: number; output: string }> {
  return uninstallAssentor({ purge: Boolean(options?.purge) });
}

export { getLocalVersionSync };
