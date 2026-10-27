import path from "node:path";
import { loadAssentorConfig } from "../config/load.js";
import { userAssentorDir } from "../config/paths.js";
import { resolveTeams } from "../config/teams.js";
import { expandSeatSpecs, type Seat } from "../core/seats.js";
import { CliModelCatalog } from "../models/cli-catalog.js";
import { PromptLibrary, promptLayerDirs } from "../prompts/library.js";
import { RpcErrorCode } from "../protocol/rpc.js";
import { RpcError, type RpcServer } from "./server.js";

/**
 * Read-only engine methods over the prompt library, the team config and the
 * model catalog (T04-04p). Nothing here writes, deletes or starts a process:
 * the model catalog is read from its cache only, never through `discover()`.
 */

export interface LibraryMethodsOptions {
  /** Project whose `.assentor/` the methods read. */
  projectPath: string;
  /** Overrides the catalog (tests). Default: `new CliModelCatalog()`, read per call. */
  createCatalog?: () => CliModelCatalog;
}

/** Registers `prompt.list`, `prompt.get`, `team.list` and `models.catalog`. */
export function registerLibraryMethods(server: RpcServer, options: LibraryMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const createCatalog = options.createCatalog ?? (() => new CliModelCatalog());

  server
    .register("prompt.list", async () => {
      const library = await PromptLibrary.load({ projectPath });
      const roots = promptLayerDirs({ projectPath });
      const rootOf = new Map(roots.map((root) => [root.layer, root.dir]));
      const scrub = (message: string) =>
        scrubMessage(message, roots.map((root) => [root.dir, "<prompts>"]));

      return {
        prompts: library.list().map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          role: prompt.role,
          ...(prompt.description ? { description: prompt.description } : {}),
          source: prompt.layer,
          overridden: prompt.overrides !== undefined,
        })),
        errors: library.errors.map((error) => ({
          file: relativeFile(rootOf.get(error.layer) ?? projectPath, error.file),
          message: scrub(error.message),
        })),
      };
    })
    .register("prompt.get", async ({ id }) => {
      const library = await PromptLibrary.load({ projectPath });
      const prompt = library.get(id);
      if (!prompt) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Unknown prompt ${id}`);
      }
      // Drop the fields that are not front-matter: the body is returned on its own,
      // and the absolute file path and the layer bookkeeping stay out of the result.
      const { body, layer, file: _file, overrides: _overrides, ...frontMatter } = prompt;
      return {
        id: prompt.id,
        title: prompt.title,
        role: prompt.role,
        source: layer,
        frontMatter,
        body,
      };
    })
    .register("team.list", async () => {
      let config: Awaited<ReturnType<typeof loadAssentorConfig>>;
      let resolved: ReturnType<typeof resolveTeams>;
      try {
        config = await loadAssentorConfig(projectPath);
        resolved = resolveTeams(config);
      } catch (error) {
        // A bad config is a client-visible state, not an engine fault: say so, without paths.
        const message = error instanceof Error ? error.message : String(error);
        throw new RpcError(
          RpcErrorCode.InvalidRequest,
          `Config problem: ${scrubMessage(message, [
            [projectPath, "<project>"],
            [userAssentorDir(), "<user>"],
          ])}`,
        );
      }
      const teams: Array<{
        name: string;
        description?: string;
        source: "config" | "legacy-review";
        seats: ReturnType<typeof publicSeats>;
      }> = Object.entries(config.teams).map(([name, team]) => ({
        name,
        ...(team.description ? { description: team.description } : {}),
        source: "config",
        seats: publicSeats(expandSeatSpecs(team.seats, { teamName: name })),
      }));

      // Without modes.review, the review team is the legacy one built from config.reviewers.
      if (config.modes.review === undefined) {
        teams.push({
          name: "legacy-review",
          description: "Reviewers from config.reviewers",
          source: "legacy-review",
          seats: publicSeats(expandSeatSpecs(resolved.review.seats)),
        });
      }

      const review = config.modes.review?.team;
      const negotiate = config.modes.negotiate?.team;
      return {
        teams,
        modes: {
          ...(review !== undefined ? { review } : {}),
          ...(negotiate !== undefined ? { negotiate } : {}),
        },
      };
    })
    .register("models.catalog", ({ provider }) => {
      const entries = createCatalog().list(provider);
      return {
        entries: entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          source: entry.source,
        })),
      };
    });

  return server;
}

/** Only the fields a client needs. Seats never carry key or vault data. */
function publicSeats(seats: Seat[]) {
  return seats.map((seat) => ({
    id: seat.id,
    displayName: seat.displayName,
    provider: seat.provider,
    transport: seat.transport,
    model: seat.model,
    role: seat.role,
    permissions: seat.permissions,
  }));
}

/** Path of a file relative to its layer's prompt directory, shown with `/` separators. */
function relativeFile(root: string, file: string): string {
  const relative = path.relative(root, file);
  return (relative.length > 0 ? relative : ".").split(path.sep).join("/");
}

/**
 * Hides absolute paths in a message: each known root becomes its label, and
 * any other absolute path becomes `<path>`.
 */
function scrubMessage(message: string, roots: Array<[string, string]>): string {
  let out = message;
  for (const [root, label] of roots) {
    out = out.split(root).join(label);
  }
  return out
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"]+/g, "<path>")
    .replace(/(^|[\s'"(])\/[^\s'")]+/g, "$1<path>");
}
