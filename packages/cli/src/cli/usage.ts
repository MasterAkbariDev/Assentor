import path from "node:path";
import type { UsageReport, UsageTotals } from "#assentor/protocol/rpc.js";

/**
 * `assentor usage` and the end-of-run usage summary (TE-01).
 */

const n = (value: number) => Math.round(value).toLocaleString("en-US");

/** One line: totals, calls, retries, cost when known. */
export function formatUsageLine(report: UsageReport): string {
  const t = report.total;
  const est = report.estimate
    ? ` · estimate ${n(report.estimate.tokens.low)}–${n(report.estimate.tokens.high)} tokens${report.estimate.usd ? ` · $${report.estimate.usd.low.toFixed(4)}–$${report.estimate.usd.high.toFixed(4)}` : ""}`
    : "";
  if (t.calls === 0) {
    return `Usage: no token counts reported by these seats${est}`;
  }
  const cached = t.cachedTokens > 0 ? ` (cached ${n(t.cachedTokens)})` : "";
  const retries = report.retries > 0 ? ` · ${report.retries} ${report.retries === 1 ? "retry" : "retries"}` : "";
  const cost = t.costUsd > 0 ? ` · $${t.costUsd.toFixed(4)}` : "";
  return `Usage: ${n(t.tokensIn + t.tokensOut)} tokens · in ${n(t.tokensIn)}${cached} · out ${n(t.tokensOut)} · ${t.calls} calls${retries}${cost}${est}`;
}

/** The summary line, then one compact table by seat / model / stage, then budget warnings. `concise`: the line only. */
export function formatUsage(report: UsageReport, options: { concise?: boolean } = {}): string[] {
  const lines = [formatUsageLine(report)];
  if (options.concise || report.total.calls === 0) {
    return lines;
  }
  const rows: Array<[string, UsageTotals]> = [
    ...Object.entries(report.bySeat).map(([id, t]): [string, UsageTotals] => [`seat ${id}`, t]),
    ...Object.entries(report.byModel).map(([id, t]): [string, UsageTotals] => [`model ${id}`, t]),
    ...(Object.keys(report.byStage).length > 1 || !report.byStage["-"]
      ? Object.entries(report.byStage).map(([id, t]): [string, UsageTotals] => [`stage ${id}`, t])
      : []),
  ];
  const width = Math.max(10, ...rows.map(([label]) => label.length));
  const cell = (value: string) => value.padStart(10);
  lines.push(`  ${"".padEnd(width)}${cell("calls")}${cell("in")}${cell("out")}${cell("cached")}`);
  for (const [label, t] of rows) {
    lines.push(`  ${label.padEnd(width)}${cell(String(t.calls))}${cell(n(t.tokensIn))}${cell(n(t.tokensOut))}${cell(n(t.cachedTokens))}`);
  }
  if (report.skippedLines) lines.push(`  ${report.skippedLines} unreadable log line(s) skipped`);
  if (report.truncated) lines.push("  log too long: totals cover its start only");
  for (const w of report.warnings) {
    lines.push(`  budget ${w.budget}${w.seatId ? ` (${w.seatId})` : ""} passed ${w.threshold * 100}%: ${w.used} of ${w.limit}`);
  }
  return lines;
}

/** `assentor usage [sessionId] [--json]`; default session = the most recently updated one with an event log. */
export async function usageCommand(input: {
  projectPath: string;
  sessionId?: string;
  json?: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}): Promise<number> {
  const projectPath = path.resolve(input.projectPath);
  const { readSessionUsage } = await import("#assentor/engine/usage/read.js");
  let sessionId = input.sessionId;
  if (!sessionId) {
    const { listSessions } = await import("#assentor/engine/rpc/sessions.js");
    sessionId = (await listSessions(projectPath)).find((s) => s.hasLiveLog)?.id;
    if (!sessionId) {
      input.err(`No sessions with an event log in ${projectPath}`);
      return 1;
    }
  }
  try {
    const report = await readSessionUsage(projectPath, sessionId);
    if (input.json) {
      input.out(JSON.stringify(report, null, 2));
    } else {
      input.out(`Session ${sessionId}`);
      for (const line of formatUsage(report)) input.out(line);
    }
    return 0;
  } catch (error) {
    input.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
