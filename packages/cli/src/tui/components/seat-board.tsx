import React from "react";
import { Box, Text } from "ink";
import {
  seatLineModel,
  STATUS_META,
  type SeatState,
  type StatusTone,
} from "#assentor/ui-shared/status.js";

/** Narrowest detail column worth showing. Below this the detail is dropped. */
const MIN_DETAIL_COLS = 8;
/** Columns for a unicode status icon, padded. Wide icons (🛠, ⏳, ⏸) take two. */
const ICON_COLS = 3;
/** Columns for an ASCII icon: the longest is `...`, so one space always follows. */
const ASCII_ICON_COLS = 4;
/**
 * Spare columns kept at the right edge of each row. Ink 5.2.1 pads ⏸ (waiting)
 * and ⏳ (rate limited) as one column, but string-width counts two, so a row with
 * either icon renders one column past its width. One column is reserved for that.
 */
const SPARE_COLS = 1;

const TONE_COLOR: Record<StatusTone, string> = {
  muted: "gray",
  info: "cyan",
  active: "blue",
  warn: "yellow",
  ok: "green",
  error: "red",
};

export interface SeatBoardProps {
  seats: Record<string, SeatState>;
  /** Columns available. Every row is cut to this width. */
  width: number;
  /** Use the ASCII icon set. The caller decides (ASSENTOR_ASCII, legacy Windows console). */
  ascii?: boolean;
  /** Current time in ms, for elapsed time. Defaults to `Date.now()`. */
  now?: number;
}

/** One live line per seat: status icon and label, name · model · role, detail, elapsed. */
export function SeatBoard({ seats, width, ascii = false, now = Date.now() }: SeatBoardProps) {
  const list = Object.values(seats);
  if (list.length === 0) {
    return <Text dimColor>No seats yet</Text>;
  }
  return (
    <Box flexDirection="column" width={width}>
      {list.map((seat) => (
        <SeatRow
          key={seat.seatId}
          seat={seat}
          width={width - SPARE_COLS}
          ascii={ascii}
          now={now}
        />
      ))}
    </Box>
  );
}

function SeatRow({
  seat,
  width,
  ascii,
  now,
}: {
  seat: SeatState;
  width: number;
  ascii: boolean;
  now: number;
}) {
  const line = seatLineModel(seat, now, ascii);
  const color = TONE_COLOR[STATUS_META[seat.status].tone];
  const who = [line.name, line.model, line.role].filter(Boolean).join(" · ");

  // Explicit column widths: Ink's flex shrink does not clip text, so it can
  // overlap columns. Each text column truncates to its own width. Elapsed is
  // always shown; the detail is dropped when there is no room for it.
  const iconCols = ascii ? ASCII_ICON_COLS : ICON_COLS;
  const elapsedCols = line.elapsed ? line.elapsed.length + 1 : 0;
  const room = width - elapsedCols;
  let leftCols = Math.floor(room * 0.6);
  let detailCols = room - leftCols - 1;
  if (detailCols < MIN_DETAIL_COLS) {
    leftCols = room;
    detailCols = 0;
  }

  // The icon gets a fixed box so the truncated text is plain ASCII, not mixed
  // with wide glyphs. Ink still pads ⏳ as one column, hence SPARE_COLS.
  return (
    <Box width={width}>
      <Box width={iconCols}>
        <Text color={color} bold>
          {line.icon}
        </Text>
      </Box>
      <Box width={leftCols - iconCols}>
        <Text wrap="truncate-end">
          <Text color={color} bold>
            {line.label}
          </Text>
          {"  "}
          {who}
        </Text>
      </Box>
      {detailCols > 0 ? (
        <Box width={detailCols + 1} paddingLeft={1}>
          <Text wrap="truncate-end" dimColor>
            {line.detail}
          </Text>
        </Box>
      ) : null}
      {elapsedCols > 0 ? (
        <Box width={elapsedCols} paddingLeft={1}>
          <Text>{line.elapsed}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
