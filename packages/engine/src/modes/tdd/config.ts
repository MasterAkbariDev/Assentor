import { z } from "zod";
import type { Seat } from "#assentor/protocol/seats.js";
import { DEFAULT_TEST_PATTERNS } from "./tamper.js";

/**
 * `modes.tdd` (T02B-11). Unknown keys are refused so a typo cannot silently weaken a gate.
 * The same fields (minus `team`) are the options of the tdd execute stage.
 */
export const TddModeSchema = z
  .object({
    /** Name of a key in `teams`: one `test-writer` edit seat and one coder edit seat. */
    team: z.string().min(1),
    /**
     * Test command for both gates. Default: `verification.commands.test`, else detected.
     * `{files}` is replaced by the locked test files (shell-quoted); without it the whole suite runs.
     */
    testCommand: z.string().min(1).optional(),
    /** Globs that say which files are tests (default: `DEFAULT_TEST_PATTERNS`). */
    testPatterns: z.array(z.string().min(1)).min(1).optional(),
    /** How the result lands in the project. `patch` is refused: it leaves the checkout dirty for the next round. */
    apply: z.enum(["merge", "squash"]).optional(),
    /** Coder runs per round while Gate B stays red (the failing output is fed back). Default 2. */
    maxCoderAttempts: z.number().int().min(1).max(5).optional(),
    /** Deadline per seat run. */
    seatTimeoutMs: z.number().positive().optional(),
    /** Deadline per gate command. Default 5 minutes. */
    gateTimeoutMs: z.number().positive().optional(),
  })
  .strict();
export type TddModeConfig = z.infer<typeof TddModeSchema>;

export interface TddOptions {
  testCommand?: string;
  testPatterns: readonly string[];
  apply: "merge" | "squash";
  maxCoderAttempts: number;
  seatTimeoutMs?: number;
  gateTimeoutMs?: number;
}

/** Validate a tdd stage's `options`. Returns the options with defaults, or an error message. */
export function parseTddOptions(options: Readonly<Record<string, unknown>>): TddOptions | string {
  const parsed = TddModeSchema.omit({ team: true }).safeParse(options);
  if (!parsed.success) {
    return `tdd: ${parsed.error.issues.map((i) => `${i.path.join(".") || "options"}: ${i.message}`).join("; ")}`;
  }
  const { testCommand, testPatterns, apply, maxCoderAttempts, seatTimeoutMs, gateTimeoutMs } = parsed.data;
  return {
    ...(testCommand ? { testCommand } : {}),
    testPatterns: testPatterns ?? DEFAULT_TEST_PATTERNS,
    apply: apply ?? "squash",
    maxCoderAttempts: maxCoderAttempts ?? 2,
    ...(seatTimeoutMs ? { seatTimeoutMs } : {}),
    ...(gateTimeoutMs ? { gateTimeoutMs } : {}),
  };
}

/**
 * The two seats TDD needs from a team: exactly one `test-writer` edit seat and exactly one other
 * edit seat (the coder). Read-only seats are ignored. Returns a problem when the team does not fit.
 */
export function selectTddSeats(seats: readonly Seat[]): { testWriter: Seat; coder: Seat } | string {
  const edit = seats.filter((seat) => seat.permissions === "edit");
  const writers = edit.filter((seat) => seat.role === "test-writer");
  const coders = edit.filter((seat) => seat.role !== "test-writer");
  if (writers.length !== 1 || coders.length !== 1) {
    return `tdd needs exactly one edit seat with role "test-writer" and exactly one other edit seat (the coder); the team has ${writers.length} test-writer and ${coders.length} other edit seats`;
  }
  return { testWriter: writers[0]!, coder: coders[0]! };
}
