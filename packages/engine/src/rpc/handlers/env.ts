import path from "node:path";
import { CliModelCatalog } from "../../models/cli-catalog.js";
import { buildExecutorRegistry } from "../../executors/index.js";
import { createAssentorServices, runFullDiagnostics, type DiagnosticItem } from "../../services/app.js";
import { redactSecrets } from "../../security/redact.js";
import { scrubMessage } from "../library.js";
import type { RpcServer } from "../server.js";

/**
 * `env.doctor`, `env.detectClis`, `models.discover` (T04-04). All three start
 * processes or call providers (`doctor` also updates key health), so all are
 * `write`. Text sent back has absolute paths replaced by `<path>`.
 */

export interface EnvMethodsOptions {
  projectPath: string;
  /** Overrides (tests never spawn or call providers). */
  runDiagnostics?: () => Promise<DiagnosticItem[]>;
  detectClis?: () => ReturnType<ReturnType<typeof buildExecutorRegistry>["detectAll"]>;
  createCatalog?: () => CliModelCatalog;
}

export function registerEnvMethods(server: RpcServer, options: EnvMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  // Provider messages can echo a key; paths and key-like tokens never leave the engine.
  const scrub = (text: string) => redactSecrets(scrubMessage(text, [[projectPath, "<project>"]])).text;
  const runDiagnostics =
    options.runDiagnostics ?? (async () => runFullDiagnostics(await createAssentorServices(projectPath)));
  const detectClis = options.detectClis ?? (() => buildExecutorRegistry().detectAll());
  const createCatalog = options.createCatalog ?? (() => new CliModelCatalog());

  return server.registerAll({
    "env.doctor": async () => ({
      items: (await runDiagnostics()).map((item) => ({ name: item.name, ok: item.ok, detail: scrub(item.detail) })),
    }),
    "env.detectClis": async () => ({
      clis: (await detectClis()).map(({ id, name, detection }) => ({
        id,
        name,
        installed: detection.installed,
        available: detection.available,
        ...(detection.version ? { version: detection.version } : {}),
        ...(detection.authenticated !== undefined ? { authenticated: detection.authenticated } : {}),
        ...(detection.error ? { error: scrub(detection.error) } : {}),
      })),
    }),
    "models.discover": async ({ provider }) => {
      const { entries, error } = await createCatalog().discover(provider);
      return {
        entries: entries.map((entry) => ({ id: entry.id, label: entry.label, source: entry.source })),
        ...(error ? { error: scrub(error) } : {}),
      };
    },
  });
}
