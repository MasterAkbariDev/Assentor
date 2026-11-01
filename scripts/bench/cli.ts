import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PromptLibrary } from "#assentor/engine/prompts/library.js";
import { BENCH_TASKS, BENCH_TASKS_LARGE } from "./tasks.js";
import { LONG_TASKS, runLongMock } from "./long.js";
import { gateVariant, renderReport, resolveVariant, runLive, runMock, type BenchReport } from "./tokens.js";

const USAGE = `pnpm bench:tokens [--variants baseline,style:concise,profile:economy,cache:stable,cache:legacy,skills:<a>+<b>,context:packed[@<tokens>],context:summaries[@<tokens>],context:truncate[@<tokens>],lead:summarizer] [--runs N]
                  [--gate <variant>] [--fixtures original|large|long|debate-6|lead-long] [--json] [--out <file.md>] [--model <id for the token estimate>]
                  [--live --budget <tokens> --executor <provider> [--executor-model <model>]]`;

const HEADER = `# Token benchmark (TE-10)

Net tokens per successful task = all prompt + output tokens of every call, follow-up turn and retry, divided by the tasks that passed their check. Cached tokens are part of the prompt column. \`always-on\` is the text a variant adds to every seat prompt.

- \`context:packed\` (TE-03) sends the task context through the engine's context packer (\`packPromptVariables\`): lossless merging of repeats only, or with budget cuts as \`context:packed@<tokens>\`; \`baseline\` sends it unpacked. \`--fixtures large\` swaps in the bulkier review and refactor contexts. A mock seat is blind when a line its task needs (\`needs\` in the fixtures) is cut, so a variant that over-cuts fails instead of looking small.
- \`context:summaries[@<tokens>]\` (TE-04) folds over-budget history into summariser digests; \`context:truncate[@<tokens>]\` is the same folding without the call; \`lead:summarizer\` is the Lead's ad-hoc summary. They act on the long fixtures only (\`--fixtures long\`, or \`debate-6\` / \`lead-long\`), where every summariser call is counted.
- **Mock** numbers (below, regenerated with \`--out\`) measure prompt structure only: replies are scripted, so they cannot show behavioural savings.
- **Live** numbers come from real CLIs, run by the owner: \`pnpm bench:tokens --live --budget 300000 --executor claude-code --variants <v> --gate <v>\`. Paste the output under a dated heading; it is the evidence for turning a variant on by default (gate: net tokens per success down ≥ 10%, no success-rate drop, always-on text ≤ 300 tokens).
- **Caching (TE-05)** saves billed cost, not tokens: cached input is billed at a lower rate, but net tokens per success are unchanged (\`cache:stable\` and \`cache:legacy\` have the same net column; only \`cached\` differs). The mock's fresh (uncached) input drop for \`cache:stable\` over \`cache:legacy\` (about −30%) is a best case: sequential calls to a provider with prefix caching and a warm cache. It is unverified on live runs.

`;

/** `pnpm bench:tokens` (TE-10). Returns the exit code: non-zero when `--gate` fails or the arguments are wrong. */
export async function main(argv: string[], io = { out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s) }): Promise<number> {
  let report: BenchReport;
  let gateName: string | undefined;
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
    if (values.help) {
      io.out(`${USAGE}\n`);
      return 0;
    }
    gateName = values.gate;
    const names = ["baseline", ...(values.variants ?? "style:concise,profile:economy").split(",").map((s) => s.trim()).filter(Boolean)];
    if (gateName) names.push(gateName);
    const variants = [...new Set(names)].map((name) => resolveVariant(name));
    const runs = Number(values.runs ?? 3);
    if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
    const library = PromptLibrary.loadBuiltinSync();
    const long = values.fixtures === "long" ? LONG_TASKS : LONG_TASKS.filter((t) => t === values.fixtures);
    if (values.fixtures !== undefined && !["original", "large"].includes(values.fixtures) && !long.length) throw new Error(`--fixtures must be original, large, long or one of ${LONG_TASKS.join(", ")}`);
    const tasks = values.fixtures === "large" ? BENCH_TASKS_LARGE : BENCH_TASKS;
    if (long.length) {
      if (values.live || values.budget || values.executor) throw new Error("the long fixtures are mock-only");
      report = await runLongMock({ library, variants, runs, tasks: long, ...(values.model ? { model: values.model } : {}) });
    } else if (values.live || values.budget || values.executor) {
      report = await runLive({
        library,
        variants,
        runs,
        tasks,
        live: Boolean(values.live),
        budgetTokens: Number(values.budget ?? 0),
        executor: values.executor ?? "claude-code",
        ...(values["executor-model"] ? { executorModel: values["executor-model"] } : {}),
      });
    } else {
      report = runMock({ library, variants, runs, tasks, ...(values.model ? { model: values.model } : {}) });
    }
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const gate = gateName ? { name: gateName, ...gateVariant(report, gateName) } : undefined;
  const text = renderReport(report, gate);
  if (values.out) {
    await fs.writeFile(path.resolve(values.out), `${HEADER}Generated by \`pnpm bench:tokens ${argv.join(" ")}\`.\n\n${text}`);
  }
  io.out(values.json ? `${JSON.stringify({ report, gate }, null, 2)}\n` : text);
  return gate && !gate.pass ? 1 : 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      variants: { type: "string" },
      runs: { type: "string" },
      gate: { type: "string" },
      fixtures: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      model: { type: "string" },
      live: { type: "boolean" },
      budget: { type: "string" },
      executor: { type: "string" },
      "executor-model": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
