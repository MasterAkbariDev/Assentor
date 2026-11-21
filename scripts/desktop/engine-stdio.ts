import { locateBinary } from "../../packages/engine/src/executors/cli-locator.js";
import { createEngineRpcServer } from "../../packages/engine/src/rpc/engine.js";
import { serveStdio } from "../../packages/engine/src/rpc/transports.js";

declare const ASSENTOR_ENGINE_VERSION: string;

const argument = process.argv[2];
if (argument === "--check-clis") {
  const tools = ["claude", "codex", "agy", "cursor"] as const;
  const found = Object.fromEntries(tools.map((tool) => [tool, Boolean(locateBinary(tool, { persist: false }))]));
  process.stdout.write(`${JSON.stringify(found)}\n`);
} else {
  const server = createEngineRpcServer({
    projectPath: argument ?? process.cwd(),
    engineVersion: ASSENTOR_ENGINE_VERSION,
  });
  void serveStdio(server, { input: process.stdin, output: process.stdout }).catch((error: unknown) => {
    process.stderr.write(`Assentor engine: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
