import { ModelIdSchema } from "#assentor/protocol/seats.js";

/** A write command typed in the palette. Seats are named by id or display name; the palette resolves them. */
export type Command =
  | { name: "approve" }
  | { name: "cancel" }
  | { name: "model"; seat: string; model: string }
  | { name: "stop"; seat: string };

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string };

const USAGE = {
  approve: "/approve",
  cancel: "/cancel",
  model: "/model <seat> <model>",
  stop: "/stop <seat>",
} as const;
export const COMMAND_NAMES = Object.keys(USAGE) as Array<keyof typeof USAGE>;

/** Parse `/approve`, `/cancel`, `/model <seat> <model>` or `/stop <seat>`. Undefined when the text is not one of these. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const words = text.trim().split(/\s+/);
  const name = words[0]?.slice(1).toLowerCase();
  if (!text.trim().startsWith("/") || !name || !(name in USAGE)) return undefined;
  const key = name as keyof typeof USAGE;
  const args = words.slice(1);
  const usage = (why: string) => ({ ok: false as const, error: `${why}. Usage: ${USAGE[key]}` });
  if (key === "approve" || key === "cancel") {
    return args.length === 0 ? { ok: true, command: { name: key } } : usage(`/${key} takes no arguments`);
  }
  if (key === "stop") {
    return args.length === 1 ? { ok: true, command: { name: "stop", seat: args[0]! } } : usage("Name one seat");
  }
  if (args.length !== 2) return usage("Name a seat and a model");
  const model = ModelIdSchema.safeParse(args[1]);
  if (!model.success) return { ok: false, error: `${model.error.issues[0]?.message ?? "Invalid model id"}` };
  return { ok: true, command: { name: "model", seat: args[0]!, model: model.data } };
}
