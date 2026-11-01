import { useId, useRef, useState, type FormEvent } from "react";
import { ModelIdSchema } from "#assentor/protocol/seats.js";
import type { SeatState } from "#assentor/ui-shared/status.js";
import { isLiveSeat } from "../../store/selectors.js";
import { ConfirmAction } from "./ConfirmAction.js";
import { errorText, useSessionControl } from "./useSessionControl.js";

/** Seat drawer actions: Stop seat (confirm) and Change model (validated like `ModelIdSchema`). */
export function SeatActions({ seat }: { seat: SeatState }) {
  const control = useSessionControl();
  const id = useId();
  const [stopping, setStopping] = useState(false);
  const [model, setModel] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);

  const finished = isLiveSeat(seat) ? undefined : "This seat has finished.";
  const stopReason = control.reasonFor("seat.stop") ?? finished;
  const modelReason = control.reasonFor("seat.setModel") ?? finished;

  const onModel = async (event: FormEvent) => {
    event.preventDefault();
    if (sent.current || modelReason) return;
    const parsed = ModelIdSchema.safeParse(model.trim());
    if (!parsed.success) return setFieldError(parsed.error.issues[0]?.message ?? "Invalid model id.");
    setFieldError(undefined);
    sent.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      await control.setModel(seat.seatId, parsed.data);
      setResult({ ok: true, text: `Model change to ${parsed.data} requested.` });
      setModel("");
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      sent.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="seat-actions">
      <form className="seat-actions-model" onSubmit={(e) => void onModel(e)} noValidate>
        <label htmlFor={`${id}-model`}>Model</label>
        <input
          id={`${id}-model`}
          value={model}
          disabled={modelReason !== undefined}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-err` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="AUTO or a model id"
          onChange={(e) => {
            setModel(e.target.value);
            setFieldError(undefined);
          }}
        />
        <button type="submit" className="write-btn" disabled={modelReason !== undefined || busy}>
          Change model
        </button>
      </form>
      {fieldError ? (
        <p id={`${id}-err`} className="notice error" role="alert">
          {fieldError}
        </p>
      ) : null}
      {result ? (
        <p className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      ) : null}
      <button type="button" className="write-btn" disabled={stopReason !== undefined} onClick={() => setStopping(true)}>
        Stop seat
      </button>
      {modelReason || stopReason ? <p className="write-reason">{modelReason ?? stopReason}</p> : null}
      {stopping ? (
        <ConfirmAction title={`Stop ${seat.displayName}?`} confirmLabel="Stop seat" run={() => control.stopSeat(seat.seatId)} onDone={() => setStopping(false)} onCancel={() => setStopping(false)}>
          <p>The seat stops working now.</p>
        </ConfirmAction>
      ) : null}
    </div>
  );
}
