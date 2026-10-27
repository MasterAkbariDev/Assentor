import { seatLineModel, STATUS_META, type SeatState } from "@engine/ui-shared/status.js";
import { useEngine } from "../../store/context.js";
import { formatClock } from "./activity.js";

/**
 * The seat's facts: provider, transport and permissions from `seat.spawned`,
 * plus status, timing, tokens and ids. Read-only.
 */
export function SeatInfo({ seat, now }: { seat: SeatState; now: number }) {
  const info = useEngine((s) => (s.session ? s.session.seatInfo[seat.seatId] : undefined));
  const sessionId = useEngine((s) => s.session?.id);
  const line = seatLineModel(seat, now);
  const rows: Array<[string, string]> = [
    ["Name", seat.displayName],
    ["Provider", info?.provider ?? "—"],
    ["Transport", info?.transport ?? "—"],
    ["Model", seat.model],
    ["Role", seat.role || "—"],
    ["Permissions", info?.permissions ?? "—"],
    ["Status", STATUS_META[seat.status].label],
    ["Started", formatClock(seat.startedAt) || "—"],
    ["Ended", formatClock(seat.endedAt) || "—"],
    ["Elapsed", line.elapsed || "—"],
    ["Tokens", `${seat.tokensIn} in · ${seat.tokensOut} out`],
    ["Seat id", seat.seatId],
    ["Session id", sessionId ?? "—"],
  ];
  return (
    <dl className="seat-info">
      {rows.map(([label, value]) => (
        <div key={label} className="seat-info-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
