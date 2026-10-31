import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import {
  MAX_PROMPT_FILE_BYTES,
  PromptLibrary,
  promptLayerDirs,
  renderPrompt,
  TemplateError,
  templateVariables,
  validateFrontMatter,
  type TemplateVariables,
} from "../../prompts/index.js";
import { userAssentorDir } from "../../config/paths.js";
import { scrubMessage } from "../library.js";
import { RpcError, type RpcServer } from "../server.js";

/**
 * `prompt.save`, `prompt.fork`, `prompt.preview`, `prompt.validate` (T04-04).
 * Writes go only to `<layer dir>/<id>.md` in the user or project layer, where
 * `id` has passed the kebab-case front-matter check (no separators or dots), so
 * an id can never name another path. Built-in prompts are never written.
 */

export interface PromptMethodsOptions {
  projectPath: string;
}

/** `target` resolved through symlinks as far as it exists; the missing tail is appended unchanged. */
async function realpathAllowingMissing(target: string): Promise<string> {
  const tail: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** A layer directory that is (or sits behind) a symlink out of its root must not be written through. */
async function assertInsideRoot(dir: string, root: string): Promise<void> {
  const real = await realpathAllowingMissing(dir);
  const relative = path.relative(await realpathAllowingMissing(root), real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RpcError(RpcErrorCode.InvalidParams, "The prompt directory resolves outside its root; not writing there");
  }
}

/** Everything wrong with a prompt before it is written, plus the variables its body reads. */
function checkPrompt(frontMatter: Record<string, unknown>, body: string, library: PromptLibrary) {
  const problems: string[] = [];
  const checked = validateFrontMatter(frontMatter);
  if (!checked.ok) {
    problems.push(checked.message);
  }
  let variables: string[] = [];
  try {
    variables = templateVariables(body);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const value = checked.ok ? checked.value : undefined;
  if (value?.extends !== undefined && !library.has(value.extends)) {
    problems.push(`extends unknown prompt "${value.extends}"`);
  }
  const undeclared = value ? variables.filter((name) => !value.variables.includes(name)) : [];
  return { problems, variables, undeclared, value };
}

export function registerPromptMethods(server: RpcServer, options: PromptMethodsOptions): RpcServer {
  const projectPath = path.resolve(options.projectPath);
  const roots = promptLayerDirs({ projectPath });
  const scrub = (message: string) => scrubMessage(message, roots.map((root) => [root.dir, "<prompts>"]));

  /** Writes `<id>.md` into the scope's layer, then reloads; a file the library rejects is rolled back. */
  async function write(scope: "user" | "project", id: string, frontMatter: object, body: string): Promise<void> {
    const dir = roots.find((root) => root.layer === scope)!.dir;
    const file = path.join(dir, `${id}.md`);
    const text = `---\n${stringifyYaml(frontMatter, { lineWidth: 100 })}---\n${body}\n`;
    if (Buffer.byteLength(text) > MAX_PROMPT_FILE_BYTES) {
      throw new RpcError(RpcErrorCode.InvalidParams, `Prompt is larger than ${MAX_PROMPT_FILE_BYTES} bytes`);
    }
    await assertInsideRoot(dir, scope === "project" ? projectPath : userAssentorDir());
    const previous = await fs.readFile(file, "utf8").catch(() => undefined);
    await fs.mkdir(dir, { recursive: true });
    // Temp file + rename: a crash never leaves a half-written prompt, and a symlink at `file` is replaced, not followed.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }

    const problem = (await PromptLibrary.load({ projectPath })).errors.find((error) => error.file === file);
    if (problem) {
      if (previous === undefined) {
        await fs.rm(file, { force: true });
      } else {
        await fs.writeFile(file, previous, "utf8");
      }
      throw new RpcError(RpcErrorCode.InvalidParams, `Prompt rejected: ${scrub(problem.message)}`);
    }
  }

  return server.registerAll({
    "prompt.save": async ({ scope, frontMatter, body }) => {
      const checked = checkPrompt(frontMatter, body, await PromptLibrary.load({ projectPath }));
      if (!checked.value || checked.problems.length > 0) {
        throw new RpcError(RpcErrorCode.InvalidParams, checked.problems.join("; "));
      }
      await write(scope, checked.value.id, checked.value, body);
      return { id: checked.value.id, scope };
    },
    "prompt.fork": async ({ id, scope, newId }) => {
      const library = await PromptLibrary.load({ projectPath });
      const source = library.get(id);
      if (!source) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Unknown prompt ${id}`);
      }
      const target = newId ?? id;
      if (library.versions(target).some((definition) => definition.layer === scope)) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Prompt ${target} already exists in the ${scope} layer`);
      }
      // A full copy (an `extends` prompt is already merged), not a child that would follow later parent edits.
      const { body, layer: _layer, file: _file, overrides: _overrides, ...frontMatter } = source;
      await write(scope, target, { ...frontMatter, id: target, extends: undefined }, body);
      return { id: target, scope };
    },
    "prompt.preview": async ({ id, variables, body }) => {
      const prompt = (await PromptLibrary.load({ projectPath })).get(id);
      if (!prompt) {
        throw new RpcError(RpcErrorCode.InvalidParams, `Unknown prompt ${id}`);
      }
      try {
        return { ok: true, text: renderPrompt(body ?? prompt.body, variables as TemplateVariables), missing: [] };
      } catch (error) {
        if (error instanceof TemplateError) {
          return { ok: false, missing: error.missing, message: error.message };
        }
        throw error;
      }
    },
    "prompt.validate": async ({ frontMatter, body }) => {
      const { problems, variables, undeclared } = checkPrompt(frontMatter, body, await PromptLibrary.load({ projectPath }));
      return { ok: problems.length === 0, problems, variables, undeclared };
    },
  });
}
