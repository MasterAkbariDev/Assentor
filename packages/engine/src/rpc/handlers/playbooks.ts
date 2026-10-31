import path from "node:path";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import { PlaybookLibrary, playbookLayerDirs, type PlaybookDefinition } from "../../playbooks/library.js";
import { scrubMessage } from "../library.js";
import { RpcError, type RpcServer } from "../server.js";

/** `playbook.list`, `playbook.get` (T04-04): read-only; file paths never leave the engine. */

export interface PlaybookMethodsOptions {
  projectPath: string;
}

const summary = (playbook: PlaybookDefinition) => ({
  id: playbook.id,
  title: playbook.title,
  description: playbook.description,
  readOnly: playbook.readOnly,
  source: playbook.layer,
  overridden: playbook.overrides !== undefined,
});

export function registerPlaybookMethods(server: RpcServer, options: PlaybookMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const roots = playbookLayerDirs({ projectPath });

  return server.registerAll({
    "playbook.list": async () => {
      const library = await PlaybookLibrary.load({ projectPath });
      const rootOf = new Map(roots.map((root) => [root.layer, root.dir]));
      return {
        playbooks: library.list().map(summary),
        errors: library.errors.map((error) => ({
          file: path.relative(rootOf.get(error.layer) ?? projectPath, error.file).split(path.sep).join("/"),
          message: scrubMessage(error.message, roots.map((root) => [root.dir, "<playbooks>"])),
        })),
      };
    },
    "playbook.get": async ({ id }) => {
      const playbook = (await PlaybookLibrary.load({ projectPath })).get(id);
      if (!playbook) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Unknown playbook ${id}`);
      }
      return { ...summary(playbook), teams: playbook.teams, stages: playbook.stages };
    },
  });
}
