import React from "react";
import type { LogicalAgentProfile } from "../../agents/index.js";
import { Table } from "../components/table.js";

export function AgentsScreen({
  agents,
  selected,
  focused,
}: {
  agents: LogicalAgentProfile[];
  selected: number;
  focused: boolean;
}) {
  return (
    <Table
      focused={focused}
      selected={selected}
      columns={[
        { key: "name", label: "NAME", width: 18 },
        { key: "kind", label: "KIND", width: 10 },
        { key: "model", label: "MODEL", width: 22 },
        { key: "on", label: "ON", width: 4 },
      ]}
      rows={
        agents.length
          ? agents.map((a) => ({
              name: a.name,
              kind: a.kind,
              model: `${a.provider}/${a.model}`,
              on: a.enabled ? "yes" : "no",
            }))
          : [{ name: "(no agents)", kind: "", model: "", on: "" }]
      }
    />
  );
}
