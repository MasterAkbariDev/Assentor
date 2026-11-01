import { useMemo } from "react";
import { LEAD_STAGES, LEAD_STAGE_LABELS, leadStages, type LeadStage, type LeadTaskView } from "#assentor/ui-shared/lead.js";
import { STATUS_META, type SeatState } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { selectLeadBoard, selectSeats } from "../../store/selectors.js";
import { ApprovalsPanel } from "../controls/ApprovalsPanel.js";
import { LeadLog } from "./LeadLog.js";
import { LeadOrgChart } from "./LeadOrgChart.js";

/**
 * The lead team board of the selected run (T04-17, watch-only): task stages,
 * the org chart and the lead log. Shows nothing unless the run is in lead mode.
 * Write controls: the integration approval (`session.approve`). Override, pin and
 * pause need RPCs the engine does not have. Cards open the owner's seat drawer.
 */
export function LeadBoard() {
  const lead = useEngine(selectLeadBoard);
  const seats = useEngine(selectSeats) ?? {};
  const openSeat = useEngine((s) => s.openSeat);
  const stages = useMemo(() => (lead ? leadStages(lead) : undefined), [lead]);
  if (!lead || !stages) {
    return null;
  }
  return (
    <section className="lead-board" aria-label="Team board">
      <h2 className="lead-title">
        Team board
        {lead.turn > 0 ? <span className="lead-turn"> · turn {lead.turn}</span> : null}
      </h2>
      <ApprovalsPanel scope="integration" />
      <div className="lead-stages">
        {LEAD_STAGES.map((stage) => (
          <LeadStageColumn key={stage} stage={stage} tasks={stages[stage]} seats={seats} onOpen={openSeat} />
        ))}
      </div>
      <div className="lead-panels">
        <LeadOrgChart seats={seats} />
        <LeadLog actions={lead.actions} total={lead.actionsTotal} />
      </div>
    </section>
  );
}

function LeadStageColumn({
  stage,
  tasks,
  seats,
  onOpen,
}: {
  stage: LeadStage;
  tasks: LeadTaskView[];
  seats: Record<string, SeatState>;
  onOpen: (seatId: string) => void;
}) {
  const title = LEAD_STAGE_LABELS[stage];
  return (
    <section className="lead-stage" aria-label={title}>
      <h3 className="lead-stage-title">
        <span>{title}</span>
        <span className="lead-stage-count">{tasks.length}</span>
      </h3>
      {tasks.length === 0 ? (
        <p className="lead-stage-empty">No tasks</p>
      ) : (
        <ul className="lead-cards">
          {tasks.map((task) => (
            <li key={task.id}>
              <LeadTaskCard task={task} seat={Object.hasOwn(seats, task.seatId) ? seats[task.seatId] : undefined} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A task card. With a live owner seat it is a button that opens that seat's drawer; otherwise plain text. */
function LeadTaskCard({ task, seat, onOpen }: { task: LeadTaskView; seat?: SeatState; onOpen: (seatId: string) => void }) {
  const body = (
    <>
      <span className="lead-task-head">
        <span className="lead-task-id">{task.id}</span> <span className="lead-task-title">{task.title}</span>
      </span>
      <span className="lead-task-owner">
        {seat ? (
          <>
            <span aria-hidden="true">{STATUS_META[seat.status].icon}</span> <span>{STATUS_META[seat.status].label}</span>
            {" · "}
            <span>{seat.displayName}</span>
            {" · "}
            <span className="lead-task-model">{seat.model}</span>
          </>
        ) : (
          <span>{task.owner || "Unassigned"}</span>
        )}
      </span>
      <span className="lead-task-counters">
        Reassigned {task.reassigns} · Escalated {task.escalations}
      </span>
    </>
  );
  if (!seat) {
    return <div className="lead-task">{body}</div>;
  }
  return (
    <button
      type="button"
      className="lead-task lead-task-open"
      aria-haspopup="dialog"
      onClick={(event) => {
        // Focus the card first: the drawer returns focus to whatever had it (Safari does not focus buttons on click).
        event.currentTarget.focus();
        onOpen(task.seatId);
      }}
    >
      {body}
    </button>
  );
}
