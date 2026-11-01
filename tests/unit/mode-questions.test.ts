import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "../../packages/engine/src/index.js";
import { createAnswerLoop, type QuestionIO } from "../../packages/cli/src/cli/mode-questions.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const event = (type: string, data: Record<string, unknown>, stageId?: string) =>
  ({ v: 1, seq: 1, ts: "", type, sessionId: SESSION, ...(stageId ? { stageId } : {}), data }) as unknown as EngineEvent;
const question = (questionId: string, kind: "approval" | "question", options?: string[]) =>
  event("user.question", { questionId, question: `Q ${questionId}?`, kind, ...(options ? { options } : {}) });

function setup(io: QuestionIO, accept: (id: string, answer: string) => boolean = () => true) {
  const calls: string[] = [];
  const loop = createAnswerLoop({
    io,
    answer: (id, answer) => (calls.push(`answer ${id} ${answer}`), accept(id, answer)),
    approveStage: (stageId) => (calls.push(`approve ${stageId}`), true),
    cancel: (reason) => void calls.push(`cancel ${reason}`),
    log: (line) => void calls.push(`log ${line}`),
  });
  return { loop, calls };
}

/** Answers each prompt with the next line; records the prompts. */
function terminal(answers: string[]): QuestionIO & { asked: string[] } {
  const input = new PassThrough();
  const asked: string[] = [];
  const output = new Writable({
    write(chunk, _e, done) {
      if (String(chunk).includes("? ")) {
        asked.push(String(chunk).trim());
        const next = answers.shift();
        if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
      }
      done();
    },
  });
  return { input, output, interactive: true, asked };
}

describe("run --mode answer loop", () => {
  it("without a terminal: denies approvals and cancels for questions and stage gates, saying why", async () => {
    const { loop, calls } = setup({ input: new PassThrough(), output: new PassThrough(), interactive: false });
    loop.onEvent(question("a", "approval", ["approve", "deny"]));
    loop.onEvent(question("b", "question", ["stop", "keep going"]));
    loop.onEvent(event("session.state", { to: "waiting" }, "build"));
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(calls).toEqual([
      "log Denied (no terminal to ask; stdin is not a TTY): Q a?",
      "answer a deny",
      'log Stopping: "Q b?" needs an answer and stdin is not a terminal.',
      "cancel a question needs an answer and stdin is not a terminal",
      'log Stopping: "Start stage "build"?" needs an answer and stdin is not a terminal.',
      "cancel a question needs an answer and stdin is not a terminal",
    ]);
  });

  it("at a terminal: y/n map to approve/deny, an unfitting answer is asked again, questions go one at a time", async () => {
    const io = terminal(["y", "maybe", "keep going", "free text"]);
    const { loop, calls } = setup(io, (_id, answer) => answer !== "maybe");
    loop.onEvent(question("a", "approval"));
    loop.onEvent(question("b", "question", ["stop", "keep going"]));
    loop.onEvent(question("c", "question"));
    await vi.waitFor(() => expect(calls).toContain("answer c free text"));
    expect(calls.filter((c) => c.startsWith("answer"))).toEqual(["answer a approve", "answer b maybe", "answer b keep going", "answer c free text"]);
    expect(calls).toContain("log Answer one of: stop/keep going.");
    expect(io.asked[0]).toContain("Q a? [approve/deny]");
    loop.close();
  });

  it("a stage gate: yes approves the stage, no cancels the session", async () => {
    const yes = setup(terminal(["yes"]));
    yes.loop.onEvent(event("session.state", { to: "waiting" }, "build"));
    await vi.waitFor(() => expect(yes.calls).toHaveLength(1));
    expect(yes.calls).toEqual(["approve build"]);

    const no = setup(terminal(["n"]));
    no.loop.onEvent(event("session.state", { to: "waiting" }, "build"));
    await vi.waitFor(() => expect(no.calls).toHaveLength(1));
    expect(no.calls).toEqual(['cancel the user did not approve stage "build"']);
  });

  it("close() ends a prompt still waiting for a line; nothing is answered", async () => {
    const io = terminal([]);
    const { loop, calls } = setup(io);
    loop.onEvent(question("a", "approval"));
    await vi.waitFor(() => expect(io.asked).toHaveLength(1));
    loop.close();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([]);
  });

  it("stdin closing (Ctrl+D) at a prompt cancels the session; nothing is answered", async () => {
    const io = terminal([]);
    const { loop, calls } = setup(io);
    loop.onEvent(question("a", "approval"));
    await vi.waitFor(() => expect(io.asked).toHaveLength(1));
    (io.input as PassThrough).end();
    await vi.waitFor(() => expect(calls).toContain("cancel stdin closed"));
    expect(calls.filter((c) => c.startsWith("answer"))).toEqual([]);
    loop.close();
  });
});

describe("reporter output while a question is open", () => {
  it("holds notes (and the spinner) until the prompt closes, then prints them in order", async () => {
    const { RunReporter } = await import("../../packages/cli/src/cli/ui/reporter.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reporter = new RunReporter({ executorName: "e", reviewerName: "r" });
      reporter.holdOutput(true);
      const write = vi.spyOn(process.stdout, "write");
      reporter.note("first");
      // A Supervisor state line printed directly is held too.
      reporter.onEvent({ type: "state.changed", data: { to: "DONE" } } as never);
      reporter.note("second");
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
      reporter.holdOutput(false);
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("first"),
        expect.stringContaining("Task passed review"),
        expect.stringContaining("second"),
      ]);
      reporter.dispose();
    } finally {
      log.mockRestore();
    }
  });
});
