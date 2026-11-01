import readline from "node:readline";
import { profileOf } from "#assentor/engine/config/profile.js";
import type { AssentorConfig } from "#assentor/engine/config/schema.js";
import type { SessionEstimate } from "#assentor/engine/estimate/cost.js";
import type { RunEstimate } from "#assentor/protocol/events.js";
import type { QuestionIO } from "./mode-questions.js";

/** Pre-run estimate line and the confirm/refuse gate (TE-09). */

const n = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * One line before a run. `excludesExecutor` marks mode runs, whose execute
 * stages are not estimated. The profile is the run's (`balanced` unless `run.profile` / `--profile`).
 */
export function formatRunEstimate(
  estimate: SessionEstimate,
  config: AssentorConfig,
  modeLabel: string,
  options: { excludesExecutor: boolean },
): string {
  const tokens = `${n(estimate.totalLow)}–${n(estimate.totalHigh)} tokens`;
  const cost = estimate.usd
    ? `$${estimate.usd.low.toFixed(4)}–$${estimate.usd.high.toFixed(4)}`
    : "cost not estimated (no pricing)";
  const seats = estimate.perSeat.length;
  const team = config.modes.review?.team ? `team ${config.modes.review.team}` : "legacy reviewers";
  const excludes = options.excludesExecutor ? " · excludes executor" : "";
  return `Estimate: ${tokens}, ${cost} · ${modeLabel}${excludes} · ${team} · ${seats} ${seats === 1 ? "seat" : "seats"} · review rounds 1–${config.limits.maxRounds} · profile ${profileOf(config)}`;
}

/** The estimate as the `session.estimate` event and the usage report carry it. */
export function toRunEstimate(estimate: SessionEstimate): RunEstimate {
  return {
    tokens: { low: estimate.totalLow, high: estimate.totalHigh },
    ...(estimate.usd ? { usd: estimate.usd } : {}),
  };
}

/** Why `limits.confirmAboveUsd` cannot be checked for this run (no observed price), or undefined. */
export function usdGateNote(estimate: SessionEstimate, limits: AssentorConfig["limits"]): string | undefined {
  if (limits.confirmAboveUsd === undefined || estimate.usd) return undefined;
  return `confirmAboveUsd not enforced for ${estimate.unpriced.join(", ")}: no observed price yet`;
}

/** Why the estimate passes a `limits.confirmAbove*` value (its high end counts), or undefined. */
export function overEstimateLimit(estimate: SessionEstimate, limits: AssentorConfig["limits"]): string | undefined {
  if (limits.confirmAboveTokens !== undefined && estimate.totalHigh > limits.confirmAboveTokens) {
    return `estimate up to ${n(estimate.totalHigh)} tokens is above limits.confirmAboveTokens (${n(limits.confirmAboveTokens)})`;
  }
  if (limits.confirmAboveUsd !== undefined && estimate.usd && estimate.usd.high > limits.confirmAboveUsd) {
    return `estimate up to $${estimate.usd.high.toFixed(4)} is above limits.confirmAboveUsd ($${limits.confirmAboveUsd})`;
  }
  return undefined;
}

/**
 * Asks before an over-limit run on a terminal; refuses without one unless `yes`.
 * Throws when the run must not start. `hold` keeps a live reporter quiet while
 * the question waits. Callers skip it on resume (no `--yes` there).
 */
export async function confirmRunEstimate(input: {
  estimate: SessionEstimate;
  limits: AssentorConfig["limits"];
  yes?: boolean;
  io: QuestionIO;
  hold?: (open: boolean) => void;
  log: (line: string) => void;
}): Promise<void> {
  const note = usdGateNote(input.estimate, input.limits);
  if (note) input.log(note);
  const reason = overEstimateLimit(input.estimate, input.limits);
  if (!reason) return;
  if (input.yes) {
    input.log(`${reason}; starting anyway (--yes)`);
    return;
  }
  if (!input.io.interactive) {
    throw new Error(`${reason}. Re-run with --yes to start anyway, or raise the limit.`);
  }
  input.hold?.(true);
  const answer = await ask(input.io, `${reason}. Start the run? [y/N] `);
  input.hold?.(false);
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Run cancelled before it started.");
}

function ask(io: QuestionIO, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, output: io.output });
    rl.on("close", () => resolve(""));
    // readline swallows Ctrl+C on a terminal; pass it on so the run's interrupt handler cancels.
    rl.on("SIGINT", () => {
      rl.close();
      process.kill(process.pid, "SIGINT");
    });
    // Resolve before close: close fires the "close" listener, which resolves "" first.
    rl.question(prompt, (line) => {
      resolve(line);
      rl.close();
    });
  });
}
