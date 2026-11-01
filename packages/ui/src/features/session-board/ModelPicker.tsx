import { useEffect, useId, useState } from "react";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { SEAT_PROVIDERS } from "#assentor/protocol/seats.js";
import type { SeatState } from "#assentor/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { isLiveSeat } from "../../store/selectors.js";
import { useCanWrite, useRpc } from "../../transport/context.js";
import type { Transport } from "../../transport/types.js";
import { errorText, READ_ONLY_REASON } from "../controls/useSessionControl.js";

type Entries = RpcResult<"models.catalog">["entries"];
type Provider = (typeof SEAT_PROVIDERS)[number];

// One `models.catalog` per transport and provider, however many cards ask. A failed call is forgotten so a later card retries.
const catalogs = new WeakMap<Transport, Map<string, Promise<Entries>>>();

function loadCatalog(rpc: Transport, provider: Provider): Promise<Entries> {
  const byProvider = catalogs.get(rpc) ?? new Map<string, Promise<Entries>>();
  catalogs.set(rpc, byProvider);
  let pending = byProvider.get(provider);
  if (!pending) {
    pending = rpc.call("models.catalog", { provider }).then((r) => r.entries);
    byProvider.set(provider, pending);
    pending.catch(() => byProvider.delete(provider));
  }
  return pending;
}

const isProvider = (value: string | undefined): value is Provider => (SEAT_PROVIDERS as readonly string[]).includes(value ?? "");

/**
 * Model of one seat. Choosing a model calls `seat.setModel`, which applies at the seat's next turn, so the picker
 * shows "pending" until `seat.model.changed` with `pending: false` arrives. Off, with a reason, when the connection
 * can't write or the seat has finished.
 * shortcut: the pending mark after a request clears when the seat reports that model; if the Supervisor applies a different one first, the mark stays until the next change.
 */
export function ModelPicker({ seat }: { seat: SeatState }) {
  const rpc = useRpc();
  const canWrite = useCanWrite();
  const id = useId();
  const provider = useEngine((s) => s.session?.seatInfo[seat.seatId]?.provider);
  const sessionId = useEngine((s) => s.session?.id);
  const storePending = useEngine((s) => s.session?.pendingModels[seat.seatId]);
  const [entries, setEntries] = useState<Entries>();
  const [requested, setRequested] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isProvider(provider)) return;
    let live = true;
    loadCatalog(rpc, provider).then(
      (list) => live && setEntries(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, provider]);
  // Once the seat is on the requested model, the request is over.
  useEffect(() => {
    if (requested !== undefined && seat.model === requested) setRequested(undefined);
  }, [requested, seat.model]);

  const pending = storePending ?? requested;
  const reason = !canWrite
    ? "Read-only connection"
    : !isLiveSeat(seat)
      ? "Seat finished"
      : !isProvider(provider)
        ? "No model list for this provider"
        : !entries
          ? "Model list not loaded"
          : undefined;
  const shown = pending ?? seat.model;
  const options = [...(entries ?? [])];
  for (const extra of ["AUTO", seat.model, shown]) {
    if (!options.some((o) => o.id === extra)) options.push({ id: extra, label: extra, source: "user" });
  }

  const onChange = async (model: string) => {
    if (reason || busy || !sessionId || model === shown) return;
    setBusy(true);
    setError(undefined);
    try {
      await rpc.call("seat.setModel", { sessionId, seatId: seat.seatId, model });
      setRequested(model);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Keys and clicks here belong to the picker, not to the card that opens the drawer.
    <div className="model-picker" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <label htmlFor={`${id}-select`} className="model-picker-label">
        Model for {seat.displayName}
      </label>
      <select
        id={`${id}-select`}
        value={shown}
        disabled={reason !== undefined || busy}
        title={!canWrite ? READ_ONLY_REASON : undefined}
        aria-describedby={[reason ? `${id}-reason` : "", pending ? `${id}-pending` : ""].filter(Boolean).join(" ") || undefined}
        onChange={(e) => void onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {pending ? (
        <span id={`${id}-pending`} className="model-picker-pending" role="status">
          pending: applies at the next turn
        </span>
      ) : null}
      {reason ? (
        <span id={`${id}-reason`} className="write-reason">
          {reason}
        </span>
      ) : null}
      {error ? (
        <span className="notice error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
