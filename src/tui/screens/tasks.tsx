import React from "react";
import { Box, Text } from "ink";
import type { TaskSnapshot } from "../../persistence/store.js";
import { Table } from "../components/table.js";

export function TasksScreen({
  tasks,
  selected,
  focused,
}: {
  tasks: TaskSnapshot[];
  selected: number;
  focused: boolean;
}) {
  if (tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No local tasks under .assentor/tasks/</Text>
        <Text dimColor>Start one: assentor run --project . &quot;…&quot;</Text>
      </Box>
    );
  }

  return (
    <Table
      focused={focused}
      selected={selected}
      columns={[
        { key: "id", label: "TASK", width: 12 },
        { key: "status", label: "STATUS", width: 14 },
        { key: "round", label: "ROUND", width: 8 },
        { key: "updated", label: "UPDATED", width: 20 },
      ]}
      rows={tasks.map((t) => ({
        id: t.taskId.slice(0, 12),
        status: t.status,
        round: `${t.currentRound}/${t.maxRounds}`,
        updated: t.updatedAt.slice(0, 19),
      }))}
    />
  );
}
