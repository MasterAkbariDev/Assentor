import { describe, expect, it } from "vitest";
import { listModes } from "#assentor/engine/modes/registry.js";
import { MODE_CATALOG, UNAVAILABLE_REASON } from "./modeCatalog.js";

const NOTE = " Not runnable yet:";

// The browser copy of the mode cards must match the engine registry exactly. The engine
// puts an unavailable mode's reason at the end of its description; the card shows it as `reason`.
describe("MODE_CATALOG", () => {
  it("matches the engine's mode registry (ids, titles, descriptions, reasons, kind, edits-code, availability, autonomy)", () => {
    const engine = listModes().map((m) => {
      const at = m.description.indexOf(NOTE);
      const description = at < 0 ? m.description : m.description.slice(0, at);
      const reason = m.available ? undefined : at < 0 ? UNAVAILABLE_REASON : m.description.slice(at + 1);
      return {
        id: m.id,
        title: m.title,
        description,
        kind: m.kind,
        editsCode: m.editsCode,
        available: m.available,
        ...(reason === undefined ? {} : { reason }),
        defaultAutonomy: m.defaultAutonomy,
      };
    });
    expect(MODE_CATALOG).toEqual(engine);
  });
});
