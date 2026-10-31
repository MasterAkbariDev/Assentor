import readline from "node:readline";
import type { EngineEvent } from "#assentor/protocol/events.js";

/** Where `run --mode` asks the user. `interactive` false: nothing is asked, approvals are denied. */
export interface QuestionIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive: boolean;
}

export function terminalQuestionIO(): QuestionIO {
  return {
    input: process.stdin,
    output: process.stdout,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

type Pending =
  | { kind: "question"; id: string; question: string; options?: string[]; approval: boolean }
  /** A static stage's approval gate (`SessionRunner`): approve releases it; there is no deny, so a no cancels. */
  | { kind: "gate"; stageId: string; question: string };

const YES = /^(y|yes|approve|ok)$/i;
/** `ask` result for Ctrl+C at the prompt: the run's SIGINT handler cancels; the loop just stops asking. */
const INTERRUPTED = Symbol("interrupted");
const NO = /^(n|no|deny)$/i;

/**
 * Answers a mode session's `user.question` events (and static approval gates)
 * from the terminal, one at a time. Fails closed: without a terminal an
 * approval is denied, and a question or gate that needs a person cancels the
 * session; each says why.
 */
export function createAnswerLoop(input: {
  io: QuestionIO;
  answer(questionId: string, answer: string): boolean;
  approveStage(stageId: string): boolean;
  /** Cancels the session (a static gate denied, or no terminal for a question). */
  cancel(reason: string): void;
  /** True while a prompt waits for a line (hold spinners and notes), false after. */
  promptOpen?(open: boolean): void;
  log(line: string): void;
}): { onEvent(event: EngineEvent): void; close(): void } {
  const queue: Pending[] = [];
  const settled = new Set<string>();
  const stop = new AbortController();
  let draining = false;

  const ask = (prompt: string): Promise<string | undefined | typeof INTERRUPTED> =>
    new Promise((resolve) => {
      if (stop.signal.aborted) return resolve(undefined);
      const rl = readline.createInterface({ input: input.io.input, output: input.io.output });
      let done = false;
      const finish = (value: string | undefined | typeof INTERRUPTED) => {
        if (done) return;
        done = true;
        stop.signal.removeEventListener("abort", onAbort);
        rl.close();
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      stop.signal.addEventListener("abort", onAbort, { once: true });
      rl.on("close", () => finish(undefined));
      // readline swallows Ctrl+C on a terminal; pass it on so the run's interrupt handler cancels.
      rl.on("SIGINT", () => {
        finish(INTERRUPTED);
        process.kill(process.pid, "SIGINT");
      });
      rl.question(prompt, (line) => finish(line));
    });

  const handle = async (item: Pending): Promise<void> => {
    const key = item.kind === "gate" ? `gate:${item.stageId}` : item.id;
    if (!input.io.interactive) {
      if (item.kind === "question" && item.approval) {
        input.log(`Denied (no terminal to ask; stdin is not a TTY): ${item.question}`);
        input.answer(item.id, "deny");
      } else {
        input.log(`Stopping: "${item.question}" needs an answer and stdin is not a terminal.`);
        input.cancel("a question needs an answer and stdin is not a terminal");
      }
      return;
    }
    const choices = item.kind === "gate" || item.approval ? "approve/deny" : item.options?.join("/");
    for (;;) {
      if (settled.has(key) || stop.signal.aborted) return;
      input.promptOpen?.(true);
      const raw = await ask(`\n? ${item.question}${choices ? ` [${choices}]` : ""} `);
      input.promptOpen?.(false);
      if (settled.has(key) || stop.signal.aborted || raw === INTERRUPTED) return;
      if (raw === undefined) {
        // stdin ended (Ctrl+D) with the question open: nobody can answer it, so fail closed.
        input.log(`Stopping: stdin closed before "${item.question}" was answered.`);
        return input.cancel("stdin closed");
      }
      const text = raw.trim();
      if (item.kind === "gate") {
        if (YES.test(text)) return void input.approveStage(item.stageId);
        if (NO.test(text)) return input.cancel(`the user did not approve stage "${item.stageId}"`);
      } else {
        const answer = item.approval ? (YES.test(text) ? "approve" : NO.test(text) ? "deny" : text) : text;
        if (input.answer(item.id, answer)) return;
      }
      input.log(choices ? `Answer one of: ${choices}.` : "Answer with 1 to 2000 characters.");
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stop.signal.aborted) await handle(queue.shift()!);
    } finally {
      draining = false;
    }
  };

  return {
    onEvent(event) {
      const data = event.data as Record<string, unknown>;
      if (event.type === "user.question" && typeof data.questionId === "string") {
        const options = Array.isArray(data.options) ? data.options.map(String) : undefined;
        queue.push({
          kind: "question",
          id: data.questionId,
          question: String(data.question ?? ""),
          ...(options ? { options } : {}),
          approval: data.kind === "approval",
        });
      } else if (event.type === "user.answer" && typeof data.questionId === "string") {
        settled.add(data.questionId);
      } else if (event.type === "session.state" && event.stageId) {
        if (data.to === "waiting") {
          queue.push({ kind: "gate", stageId: event.stageId, question: `Start stage "${event.stageId}"?` });
        } else if (data.from === "waiting") {
          settled.add(`gate:${event.stageId}`);
        }
      } else {
        return;
      }
      void drain();
    },
    close() {
      stop.abort();
    },
  };
}
