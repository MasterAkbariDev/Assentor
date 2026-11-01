#!/usr/bin/env node
// `pnpm bench:tokens` (TE-10): runs scripts/bench/cli.ts from TypeScript source
// through Vite, with the same `#assentor/*` aliases as the tests. Dev only.
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vitest.config.ts`,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true },
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const { main } = await runner.import("/scripts/bench/cli.ts");
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await runner.close();
  await server.close();
}
