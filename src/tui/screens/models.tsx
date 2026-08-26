import React from "react";
import type { ModelInfo } from "../../providers/ai/index.js";
import { Table } from "../components/table.js";

export function ModelsScreen({
  models,
  selected,
  focused,
}: {
  models: ModelInfo[];
  selected: number;
  focused: boolean;
}) {
  return (
    <Table
      focused={focused}
      selected={selected}
      columns={[
        { key: "id", label: "MODEL", width: 24 },
        { key: "provider", label: "PROVIDER", width: 12 },
        { key: "code", label: "CODE", width: 6 },
        { key: "cost", label: "COST", width: 8 },
        { key: "free", label: "FREE", width: 5 },
      ]}
      rows={
        models.length
          ? models.map((m) => ({
              id: m.id,
              provider: m.provider,
              code: String(m.codingScore),
              cost: String(m.cost),
              free: m.freeTier ? "yes" : "no",
            }))
          : [{ id: "(none)", provider: "", code: "", cost: "", free: "" }]
      }
    />
  );
}
