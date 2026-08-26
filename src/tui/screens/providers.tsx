import React from "react";
import type { AIProvider } from "../../providers/ai/index.js";
import type { StoredApiKey } from "../../keys/index.js";
import { Table } from "../components/table.js";

export function ProvidersScreen({
  providers,
  keys,
  selected,
  focused,
}: {
  providers: AIProvider[];
  keys: StoredApiKey[];
  selected: number;
  focused: boolean;
}) {
  return (
    <Table
      focused={focused}
      selected={selected}
      columns={[
        { key: "name", label: "PROVIDER", width: 14 },
        { key: "keys", label: "KEYS", width: 6 },
        { key: "healthy", label: "HEALTHY", width: 8 },
      ]}
      rows={
        providers.length
          ? providers.map((p) => {
              const pk = keys.filter((k) => k.provider === p.id);
              return {
                name: p.name,
                keys: String(pk.length),
                healthy: String(pk.filter((k) => k.health === "healthy").length),
              };
            })
          : [{ name: "(none)", keys: "0", healthy: "0" }]
      }
    />
  );
}
