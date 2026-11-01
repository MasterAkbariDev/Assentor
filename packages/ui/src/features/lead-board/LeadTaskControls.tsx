import { useEffect, useId, useRef, useState } from "react";
import type { LeadTaskView } from "#assentor/ui-shared/lead.js";
import type { SeatState } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { isLiveSeat } from "../../store/selectors.js";
import { useRpc } from "../../transport/context.js";
import { ConfirmAction } from "../controls/ConfirmAction.js";
import { errorText, useSessionControl } from "../controls/useSessionControl.js";
import { WriteButton } from "../controls/WriteButton.js";
import { isProvider, loadCatalog } from "../session-board/ModelPicker.js";

/** Model ids from `models.catalog` for every provider that has a seat in this run. */
function usePinnableModels(): string[] {
  const rpc = useRpc();
  const seatInfo = useEngine((s) => s.session?.seatInfo);
  const providers = [...new Set(Object.values(seatInfo ?? {}).map((i) => i.provider))].filter(isProvider).sort();
  const key = providers.join(",");
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(providers.map((p) => loadCatalog(rpc, p).catch(() => []))).then((lists) => {
      if (live) setModels([...new Set(lists.flat().map((e) => e.id))]);
    });
    return () => {
      live = false;
    };
    // `providers` is derived from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);
  return models;
}

/**
 * Per-task user controls on the Lead board: Override assignment (pick a seat, confirm) and Pin model
 * (pick from the catalog, or Unpin). Collapsed in a native `<details>` so a long board stays readable.
 * Task ids and seat ids are sent as the controller knows them.
 */
export function LeadTaskControls({ task, seats }: { task: LeadTaskView; seats: Record<string, SeatState> }) {
  const control = useSessionControl();
  const models = usePinnableModels();
  const id = useId();
  const [overriding, setOverriding] = useState(false);
  const [seatId, setSeatId] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const sent = useRef(false);
  const overrideReason = control.reasonFor("lead.override");
  const pinReason = control.reasonFor("lead.pin");

  const pin = async (next: string | null) => {
    if (sent.current || pinReason) return;
    sent.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      await control.leadPin(task.id, next);
      setResult({ ok: true, text: next ? `Pinned ${task.id} to ${next}.` : `Unpinned ${task.id}.` });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      sent.current = false;
      setBusy(false);
    }
  };
  const options = Object.values(seats).filter(isLiveSeat);
  const pickReason = model === "" ? "Pick a model first." : undefined;
  return (
    <details className="lead-task-controls">
      <summary>Controls for {task.id}</summary>
      <div className="lead-task-controls-body">
        <WriteButton type="button" reason={overrideReason} reasonId={`${id}-override-reason`} onClick={() => setOverriding(true)}>
          Override assignment
        </WriteButton>
        {overrideReason ? (
          <p id={`${id}-override-reason`} className="write-reason">
            {overrideReason}
          </p>
        ) : null}
        <label htmlFor={`${id}-model`}>Pin model for {task.id}</label>
        <select
          id={`${id}-model`}
          value={model}
          aria-disabled={pinReason !== undefined || busy ? true : undefined}
          aria-describedby={pinReason ? `${id}-pin-reason` : undefined}
          onChange={(e) => {
            if (pinReason === undefined && !busy) setModel(e.target.value);
          }}
        >
          <option value="">Choose a model</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <WriteButton type="button" reason={pinReason ?? pickReason} reasonId={pinReason ? `${id}-pin-reason` : `${id}-pick`} busy={busy} onClick={() => void pin(model)}>
          Pin model
        </WriteButton>
        <WriteButton
          type="button"
          reason={pinReason ?? (task.pinnedModel ? undefined : "This task has no pinned model.")}
          reasonId={pinReason ? `${id}-pin-reason` : `${id}-unpin`}
          busy={busy}
          onClick={() => void pin(null)}
        >
          Unpin model
        </WriteButton>
        {pinReason ? (
          <p id={`${id}-pin-reason`} className="write-reason">
            {pinReason}
          </p>
        ) : (
          <>
            {pickReason ? (
              <span id={`${id}-pick`} className="write-reason">
                {pickReason}
              </span>
            ) : null}
            {task.pinnedModel ? null : (
              <span id={`${id}-unpin`} className="write-reason">
                This task has no pinned model.
              </span>
            )}
          </>
        )}
        {result ? (
          <p className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"}>
            {result.text}
          </p>
        ) : null}
      </div>
      {overriding ? (
        <ConfirmAction
          title={`Override ${task.id}?`}
          confirmLabel="Override assignment"
          danger={false}
          run={async () => {
            if (!seatId) throw new Error("Pick a seat first.");
            await control.leadOverride(task.id, seatId);
          }}
          onDone={() => setOverriding(false)}
          onCancel={() => setOverriding(false)}
        >
          <p>
            Give {task.id} to another seat. The Lead applies it at its next decision point, once the task's current run has reported.
          </p>
          <label htmlFor={`${id}-seat`}>New owner</label>
          <select id={`${id}-seat`} value={seatId} onChange={(e) => setSeatId(e.target.value)}>
            <option value="">Choose a seat</option>
            {options.map((s) => (
              <option key={s.seatId} value={s.seatId}>
                {s.displayName}
                {s.seatId === task.seatId ? " (current)" : ""}
              </option>
            ))}
          </select>
        </ConfirmAction>
      ) : null}
    </details>
  );
}
