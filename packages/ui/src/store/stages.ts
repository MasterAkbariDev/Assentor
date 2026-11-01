import type { EngineEvent } from "#assentor/protocol/events.js";

/**
 * One stage of a mode run, folded from `stage.started` / `stage.completed`. The engine announces a stage only when
 * it starts, so `pending` is never produced here; `StageRail` still draws it for a stage list that names one in advance.
 */
export interface StageView {
  id: string;
  kind: string;
  strategy?: string;
  attempt: number;
  status: "pending" | "running" | "done" | "failed";
  /** From `stage.completed`: pass, needs_work, blocked, budget, cancelled or failed. */
  outcome?: string;
}

/** Apply a stage event; a stage keeps the place of its first start, and a retry reuses it. */
export function reduceStages(stages: StageView[], event: EngineEvent): StageView[] {
  if ((event.type !== "stage.started" && event.type !== "stage.completed") || !event.stageId) return stages;
  const id = event.stageId;
  const data = event.data as { kind: string; strategy?: string; attempt?: unknown; outcome?: unknown };
  const next: StageView = {
    id,
    kind: data.kind,
    ...(data.strategy ? { strategy: data.strategy } : {}),
    attempt: typeof data.attempt === "number" ? data.attempt : 1,
    ...(event.type === "stage.started"
      ? { status: "running" as const }
      : { status: data.outcome === "pass" ? ("done" as const) : ("failed" as const), outcome: String(data.outcome ?? "failed") }),
  };
  const at = stages.findIndex((s) => s.id === id);
  return at < 0 ? [...stages, next] : stages.map((s, i) => (i === at ? next : s));
}
