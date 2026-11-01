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

  it("parses /pause, /resume and /restart <seat>", () => {
    expect(parseCommand("/pause")).toEqual({ ok: true, command: { name: "pause" } });
    expect(parseCommand("/resume")).toEqual({ ok: true, command: { name: "resume" } });
    expect(parseCommand("/pause now")).toMatchObject({ ok: false });
    expect(parseCommand("/restart executor")).toEqual({ ok: true, command: { name: "restart", seat: "executor" } });
    expect(parseCommand("/restart")).toMatchObject({ ok: false });
  });

  it("parses /inject <seat> <text>, keeping the text's own spacing", () => {
    expect(parseCommand("/inject executor  use  tabs, not spaces ")).toEqual({ ok: true, command: { name: "inject", seat: "executor", text: "use  tabs, not spaces" } });
    expect(parseCommand("/inject executor")).toEqual({ ok: false, error: "Name a seat and a message. Usage: /inject <seat> <text>" });
    expect(parseCommand("/inject")).toMatchObject({ ok: false });
  });

  it("ignores anything else", () => {
    expect(parseCommand("approve")).toBeUndefined();
    expect(parseCommand("/nothing")).toBeUndefined();
  });
});
