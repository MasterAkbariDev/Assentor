import path from "node:path";
import { createModeHost } from "../../packages/cli/src/cli/mode-run.js";
import { loadAssentorConfig } from "../../packages/engine/src/config/load.js";
import { applyRunProfile } from "../../packages/engine/src/config/profile.js";
import { locateBinary } from "../../packages/engine/src/executors/cli-locator.js";
import { userAssentorProjectRoot } from "../../packages/engine/src/config/paths.js";
import { installVaultSecretMirror, KeyVault } from "../../packages/engine/src/keys/vault.js";
import { PromptLibrary } from "../../packages/engine/src/prompts/library.js";
import { createEngineRpcServer } from "../../packages/engine/src/rpc/engine.js";
import { serveStdio } from "../../packages/engine/src/rpc/transports.js";
import { setPackagedRoot } from "../../packages/engine/src/self/package-root.js";
import { expandSkillPresets, SkillLibrary, SkillSession } from "../../packages/engine/src/skills/index.js";
import { WorktreeManager } from "../../packages/engine/src/worktrees/manager.js";
import { createKeychainMirror } from "./keychain-client.js";

declare const ASSENTOR_ENGINE_VERSION: string;

const argument = process.argv[2];
if (argument === "--check-clis") {
  const tools = ["claude", "codex", "agy", "cursor"] as const;
  const found = Object.fromEntries(tools.map((tool) => [tool, Boolean(locateBinary(tool, { persist: false }))]));
  process.stdout.write(`${JSON.stringify(found)}\n`);
} else {
  const projectPath = path.resolve(argument ?? process.cwd());
  const resources = process.argv[3];
  if (resources) setPackagedRoot(resources);
  const desktopHost = process.env.ASSENTOR_DESKTOP_HOST;
  if (desktopHost && path.isAbsolute(desktopHost)) installVaultSecretMirror(createKeychainMirror(desktopHost));
  const shutdown = new AbortController();
  const worktrees = new WorktreeManager({ repoPath: projectPath });
  const server = createEngineRpcServer({
    projectPath,
    engineVersion: ASSENTOR_ENGINE_VERSION,
    maxAutonomy: "supervised",
    signal: shutdown.signal,
    worktrees,
    sessionHost: {
      async launch({ mode, goal, sessionId, emit, autonomy }) {
        const config = applyRunProfile(await loadAssentorConfig(projectPath, autonomy ? { autonomy } : {}));
        const [prompts, library] = await Promise.all([
          PromptLibrary.load({ projectPath }),
          SkillLibrary.load({ projectPath }),
        ]);
        const skills = new SkillSession(library, {
          sessionId, mode, enabled: expandSkillPresets(config.skills.enabled), emit,
        });
        return {
          config, skills, worktrees, autonomy: config.run.autonomy ?? config.run.mode,
          ...createModeHost({
            config, projectPath, sessionId, goal, worktrees, prompts, skills, emit,
            reporter: { onEvent() {}, onExecutorStatus() {}, onReviewerStatus() {} },
            hooks: {},
          }),
        };
      },
    },
  });
  if (desktopHost) server.register("keys.mirror", async ({ action }) => {
    const roots = new Set([path.resolve(userAssentorProjectRoot()), projectPath]);
    let count = 0;
    for (const root of roots) {
      const vault = new KeyVault(root);
      await vault.load();
      count += await vault.applyNativeMirror(action === "remove");
    }
    return { count };
  });
  void serveStdio(server, { input: process.stdin, output: process.stdout }, {
    resetLine: "--assentor-reset-desktop-rpc--",
  }).then(() => {
    shutdown.abort();
  }).catch((error: unknown) => {
    shutdown.abort();
    process.stderr.write(`Assentor engine: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
