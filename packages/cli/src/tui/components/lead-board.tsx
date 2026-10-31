import React from "react";
import { Box, Text } from "ink";
import {
  LEAD_COLUMNS,
  LEAD_COLUMN_LABELS,
  leadColumns,
  type LeadBoardView,
  type LeadColumn,
  type LeadLogEntry,
  type LeadTaskView,
} from "#assentor/ui-shared/lead.js";

/** Task rows shown per column before "+N more". */
const MAX_ROWS = 6;

const COLUMN_COLOR: Record<LeadColumn, string> = {
  backlog: "gray",
  in_progress: "cyan",
  in_review: "yellow",
  done: "green",
};

export interface LeadBoardProps {
  view: LeadBoardView;
  /** Columns available. Every row is cut to this width. */
  width: number;
  /** ASCII marks instead of ✓ and ✗ (ASSENTOR_ASCII, legacy Windows console). */
  ascii?: boolean;
  maxRows?: number;
}

/** Read-only team board: four task columns side by side, then the last lead actions. */
export function LeadBoard({ view, width, ascii = false, maxRows = MAX_ROWS }: LeadBoardProps) {
  const columns = leadColumns(view);
  const colWidth = Math.max(1, Math.floor(width / LEAD_COLUMNS.length));
  const taskCount = LEAD_COLUMNS.reduce((sum, column) => sum + columns[column].length, 0);
  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text bold>Team board</Text>
        {view.turn > 0 ? <Text dimColor>{`  turn ${view.turn}`}</Text> : null}
      </Box>
      {taskCount === 0 ? (
        <Text dimColor>No tasks yet</Text>
      ) : (
        <Box flexDirection="row" width={width}>
          {LEAD_COLUMNS.map((column) => (
            <ColumnView
              key={column}
              column={column}
              tasks={columns[column]}
              width={colWidth}
              maxRows={maxRows}
              ascii={ascii}
            />
          ))}
        </Box>
      )}
      <LogView log={view.log} width={width} ascii={ascii} />
    </Box>
  );
}

function ColumnView({
  column,
  tasks,
  width,
  maxRows,
  ascii,
}: {
  column: LeadColumn;
  tasks: LeadTaskView[];
  width: number;
  maxRows: number;
  ascii: boolean;
}) {
  const shown = tasks.slice(0, maxRows);
  const hidden = tasks.length - shown.length;
  // One column is kept free on the right so neighbouring columns do not touch.
  const textWidth = Math.max(1, width - 1);
  return (
    <Box flexDirection="column" width={width}>
      <Box width={textWidth}>
        <Text wrap="truncate-end" bold color={COLUMN_COLOR[column]}>
          {`${LEAD_COLUMN_LABELS[column]} (${tasks.length})`}
        </Text>
      </Box>
      {shown.map((task) => (
        <TaskRow key={task.id} task={task} width={textWidth} ascii={ascii} />
      ))}
      {hidden > 0 ? (
        <Box width={textWidth}>
          <Text wrap="truncate-end" dimColor>{`+${hidden} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function TaskRow({ task, width, ascii }: { task: LeadTaskView; width: number; ascii: boolean }) {
  const rejected = task.state === "rejected";
  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text wrap="truncate-end">
          {rejected ? <Text color="red" bold>{ascii ? "x " : "✗ "}</Text> : null}
          {`${task.id} ${task.title}`}
        </Text>
      </Box>
      {task.owner ? (
        <Box width={width}>
          <Text wrap="truncate-end" dimColor>{`  ${task.owner}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function LogView({ log, width, ascii }: { log: LeadLogEntry[]; width: number; ascii: boolean }) {
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold>Lead log</Text>
      {log.length === 0 ? <Text dimColor>No lead actions yet</Text> : null}
      {log.map((entry, index) => {
        const mark = entry.accepted ? (ascii ? "OK" : "✓") : ascii ? "X" : "✗";
        const color = entry.accepted ? "green" : "red";
        const reason = entry.reason ? `: ${entry.reason}` : "";
        return (
          <Box key={index} width={width}>
            <Text wrap="truncate-end">
              <Text color={color} bold>{mark}</Text>
              {` ${entry.action}${reason}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
