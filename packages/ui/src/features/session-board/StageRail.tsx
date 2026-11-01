import type { StageView } from "../../store/stages.js";

const ICON = { done: "✓", running: "●", pending: "○", failed: "✗" } as const;
const WORD = { done: "done", running: "running", pending: "pending", failed: "failed" } as const;
const OUTCOME_WORD: Record<string, string> = { needs_work: "needs work", budget: "over budget", blocked: "blocked", cancelled: "cancelled" };

/** Stages in order with a status icon and a status word (the icon is decorative). Hidden when the run has no stages (solo). */
export function StageRail({ stages }: { stages: readonly StageView[] }) {
  if (stages.length === 0) return null;
  return (
    <ol className="stage-rail" aria-label="Stages">
      {stages.map((stage) => {
        const word = (stage.status === "failed" && stage.outcome && OUTCOME_WORD[stage.outcome]) || WORD[stage.status];
        return (
          <li key={stage.id} className={`stage stage-${stage.status}`} aria-current={stage.status === "running" ? "step" : undefined}>
            <span className="stage-icon" aria-hidden="true">
              {ICON[stage.status]}
            </span>
            <span className="stage-label">
              {stage.kind}
              {stage.strategy ? ` · ${stage.strategy}` : ""}
              {stage.attempt > 1 ? ` · attempt ${stage.attempt}` : ""}
            </span>
            <span className="stage-status">{word}</span>
          </li>
        );
      })}
    </ol>
  );
}
