/**
 * Seat prompt order (TE-05): static → shared → per-seat delta, so a prompt
 * cache serves every byte that did not change.
 *
 * - `static`: the same for every call of this role in the session (role
 *   prompt, output schema, and TE-02's style fragment and TE-07's skills index
 *   when they land). Never put task text, ids, rounds or times here.
 * - `shared`: what every seat of the round sees, byte-identical across seats
 *   (task contract, evidence, proposals).
 * - `delta`: this seat's and this call's own text (specialty, round number).
 *
 * Empty parts are dropped; parts are joined with a blank line. `blocks` are the
 * three groups, each ending with its separator, so `blocks.join("") === text`
 * and an API provider can put a cache breakpoint after the first two.
 */
export interface SeatPromptParts {
  static: readonly string[];
  shared: readonly string[];
  delta: readonly string[];
}

export interface AssembledPrompt {
  text: string;
  /** [static, shared, delta]; each may be "". */
  blocks: [string, string, string];
}

const SEPARATOR = "\n\n";

export function assembleSeatPrompt(parts: SeatPromptParts): AssembledPrompt {
  const groups = [parts.static, parts.shared, parts.delta].map((group) => group.filter((part) => part.trim() !== "").join(SEPARATOR));
  const last = groups.reduce((at, group, i) => (group ? i : at), -1);
  const blocks = groups.map((group, i) => (group && i < last ? group + SEPARATOR : group)) as AssembledPrompt["blocks"];
  return { text: blocks.join(""), blocks };
}
