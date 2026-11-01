import { describe, expect, it } from "vitest";
import { listModes } from "#assentor/engine/modes/registry.js";
import { MODE_CATALOG } from "./modeCatalog.js";

// The browser copy of the mode cards must match the engine registry exactly.
describe("MODE_CATALOG", () => {
  it("matches the engine's mode registry (ids, titles, descriptions, kind, edits-code, availability, autonomy)", () => {
    const engine = listModes().map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      kind: m.kind,
      editsCode: m.editsCode,
      available: m.available,
      defaultAutonomy: m.defaultAutonomy,
    }));
    expect(MODE_CATALOG).toEqual(engine);
  });
});
