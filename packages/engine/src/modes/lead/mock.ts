import type { ControllerTurn } from "../controller.js";
import type { ModeHostServices } from "../registry.js";

/**
 * Scripted lead for tests (T02B-02, modes.md §4.5): a `host.askSeat` that
 * answers each lead turn with the next script entry (an object is sent as JSON,
 * a string as is, a function gets the prompt). When the script runs out it
 * throws, which the controller treats as a lead seat failure. Summarizer asks
 * get `summary`.
 */
export type MockLeadStep = ControllerTurn | string | ((prompt: string) => ControllerTurn | string);

export interface MockLead {
  askSeat: NonNullable<ModeHostServices["askSeat"]>;
  /** Lead prompts in order. */
  prompts: string[];
}

export function createMockLead(script: readonly MockLeadStep[], options: { summary?: string; tokensPerTurn?: number } = {}): MockLead {
  const steps = [...script];
  const prompts: string[] = [];
  return {
    prompts,
    async askSeat({ seat, prompt, reportUsage }) {
      if (options.tokensPerTurn) reportUsage({ tokensIn: options.tokensPerTurn });
      if (seat.role === "summarizer") return options.summary ?? "summary";
      prompts.push(prompt);
      const step = steps.shift();
      if (step === undefined) throw new Error("MockLead: the script has no more turns");
      const reply = typeof step === "function" ? step(prompt) : step;
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  };
}
