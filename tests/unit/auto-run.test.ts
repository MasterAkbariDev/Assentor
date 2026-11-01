import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseAutoMode } from "../../packages/cli/src/cli/auto-run.js";
import { formatModesTable } from "../../packages/cli/src/cli/modes.js";
import type { QuestionIO } from "../../packages/cli/src/cli/mode-questions.js";
import { getMode } from "../../packages/engine/src/modes/registry.js";
import { prepareModeSession, ModeValidationError } from "../../packages/engine/src/modes/session.js";

// `--mode auto`: the suggestion, the question, and what each answer runs.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-run-"));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

/** A terminal that types the next scripted line at each prompt; `text()` is everything printed. */
function terminal(answers: string[], interactive = true): QuestionIO & { text(): string; prompts(): number } {
  const input = new PassThrough();
  let out = "";
  let prompts = 0;
  const output = new Writable({
    write(chunk, _enc, done) {
      const s = String(chunk);
      out += s;
      if (s.includes("Run ") && s.includes("[y] yes")) {
        prompts++;
        const next = answers.shift();
        setImmediate(() => (next === undefined ? input.end() : input.write(`${next}\n`)));
      }
      done();
    },
  });
  return { input, output, interactive, text: () => out, prompts: () => prompts };
}

const REVIEW = "Please review the code in src";
const DANGER = "Please review the production database migration and drop table users";
const choose = (io: QuestionIO, over: Record<string, unknown> = {}, prompt = REVIEW) =>
  chooseAutoMode({ projectPath: dir, prompt, modeHooks: { questions: io }, ...over } as never);

describe("assentor run --mode auto", () => {
  it("shows the suggestion with its reason, and accept runs it", async () => {
    const io = terminal(["y"]);
    expect(await choose(io)).toBe("review");
    expect(io.text()).toContain("Suggested mode: review");
    expect(io.text()).toContain("asks for a review or audit");
  });

  it("picking another available mode runs that one", async () => {
    expect(await choose(terminal(["debug"]))).toBe("debug");
  });

  it("picking solo returns solo", async () => {
    expect(await choose(terminal(["solo"]))).toBe("solo");
  });

  it('typing "auto" is rejected and asked again', async () => {
    const io = terminal(["auto", "y"]);
    expect(await choose(io)).toBe("review");
    expect(io.prompts()).toBe(2);
    expect(io.text()).toContain("Not an available mode: auto");
  });

  it("asks again after a mode that is not available, then cancel runs nothing", async () => {
    const io = terminal(["watch", "n"]);
    await expect(choose(io)).rejects.toThrow("cancelled");
    expect(io.prompts()).toBe(2);
    expect(io.text()).toContain("Not an available mode: watch");
  });

  it("stdin closing at the question cancels", async () => {
    await expect(choose(terminal([]))).rejects.toThrow("cancelled");
  });

  it("autopilot and --yes accept without asking", async () => {
    for (const over of [{ autonomy: "autopilot" }, { yes: true }]) {
      const io = terminal([]);
      expect(await choose(io, over)).toBe("review");
      expect(io.prompts()).toBe(0);
    }
  });

  it("a danger-area task still asks under autopilot and --yes", async () => {
    for (const over of [{ autonomy: "autopilot" }, { yes: true }]) {
      const io = terminal(["y"]);
      expect(await choose(io, over, DANGER)).toBe("review");
      expect(io.prompts()).toBe(1);
      expect(io.text()).toContain("Danger area");
    }
  });

  it("refuses with a reason when it must ask and there is no terminal", async () => {
    await expect(choose(terminal([], false))).rejects.toThrow(/no terminal/);
    await expect(choose(terminal([], false), { autonomy: "autopilot" }, DANGER)).rejects.toThrow(/danger area/);
  });

  it("serve (prepareModeSession) refuses auto with a clear reason", () => {
    expect(() => prepareModeSession({ mode: "auto" } as never)).toThrow(ModeValidationError);
    try {
      prepareModeSession({ mode: "auto", sessionId: "0b0f4f4e-6a53-4b6a-9d0a-2f6a3c1f7d11", goal: "g", autonomy: "supervised" } as never);
    } catch (error) {
      expect((error as ModeValidationError).message).toContain("needs a terminal");
    }
  });

  it("assentor modes lists auto as available", () => {
    expect(getMode("auto")?.available).toBe(true);
    expect(formatModesTable().split("\n").find((l) => l.startsWith("auto "))).toContain("✓");
    expect(formatModesTable().split("\n").find((l) => l.startsWith("auto "))).not.toContain("not yet");
  });
});
