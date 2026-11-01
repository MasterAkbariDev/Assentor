import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("parses the four write commands", () => {
    expect(parseCommand("/approve")).toEqual({ ok: true, command: { name: "approve" } });
    expect(parseCommand("  /CANCEL ")).toEqual({ ok: true, command: { name: "cancel" } });
    expect(parseCommand("/stop reviewer-1")).toEqual({ ok: true, command: { name: "stop", seat: "reviewer-1" } });
    expect(parseCommand("/model executor claude-opus-4.5")).toEqual({ ok: true, command: { name: "model", seat: "executor", model: "claude-opus-4.5" } });
    expect(parseCommand("/model executor AUTO")).toEqual({ ok: true, command: { name: "model", seat: "executor", model: "AUTO" } });
  });

  it("explains wrong arguments and validates the model like ModelIdSchema", () => {
    expect(parseCommand("/model executor")).toEqual({ ok: false, error: "Name a seat and a model. Usage: /model <seat> <model>" });
    expect(parseCommand("/stop")).toMatchObject({ ok: false });
    expect(parseCommand("/approve now")).toMatchObject({ ok: false });
    expect(parseCommand("/model executor -rf")).toMatchObject({ ok: false });
    expect(parseCommand("/model executor bad;id")).toMatchObject({ ok: false });
  });

  it("ignores anything else, including the disabled /pause and /inject", () => {
    expect(parseCommand("approve")).toBeUndefined();
    expect(parseCommand("/pause")).toBeUndefined();
    expect(parseCommand("/inject executor hi")).toBeUndefined();
  });
});
