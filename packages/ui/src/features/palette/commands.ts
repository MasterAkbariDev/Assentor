import { ModelIdSchema } from "#assentor/protocol/seats.js";

/** A write command typed in the palette. Seats are named by id or display name; the palette resolves them. */
export type Command =
  | { name: "approve" }
  | { name: "cancel" }
  | { name: "model"; seat: string; model: string }
  | { name: "stop"; seat: string }
  | { name: "pause" }
  | { name: "resume" }
  | { name: "inject"; seat: string; text: string }
  | { name: "restart"; seat: string };

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string };

const USAGE = {
  approve: "/approve",
  cancel: "/cancel",
  model: "/model <seat> <model>",
  stop: "/stop <seat>",
  pause: "/pause",
  resume: "/resume",
  inject: "/inject <seat> <text>",
  restart: "/restart <seat>",
} as const;
export const COMMAND_NAMES = Object.keys(USAGE) as Array<keyof typeof USAGE>;

/** Parse `/approve`, `/cancel`, `/pause`, `/resume`, `/model <seat> <model>`, `/stop <seat>`, `/restart <seat>` or `/inject <seat> <text>`. Undefined when the text is not one of these. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const words = text.trim().split(/\s+/);
  const name = words[0]?.slice(1).toLowerCase();
  if (!text.trim().startsWith("/") || !name || !(name in USAGE)) return undefined;
  const key = name as keyof typeof USAGE;
  const args = words.slice(1);
  const usage = (why: string) => ({ ok: false as const, error: `${why}. Usage: ${USAGE[key]}` });
  if (key === "inject") {
    // The text keeps its own spacing and line breaks: everything after the seat word.
    const m = /^\s*\/inject\s+(\S+)\s+([\s\S]*\S)\s*$/i.exec(text);
    return m ? { ok: true, command: { name: "inject", seat: m[1]!, text: m[2]! } } : usage("Name a seat and a message");
  }
  if (key === "approve" || key === "cancel" || key === "pause" || key === "resume") {
    return args.length === 0 ? { ok: true, command: { name: key } } : usage(`/${key} takes no arguments`);
  }
  if (key === "stop" || key === "restart") {
    return args.length === 1 ? { ok: true, command: { name: key, seat: args[0]! } } : usage("Name one seat");
  }
  if (args.length !== 2) return usage("Name a seat and a model");
  const model = ModelIdSchema.safeParse(args[1]);
  if (!model.success) return { ok: false, error: `${model.error.issues[0]?.message ?? "Invalid model id"}` };
  return { ok: true, command: { name: "model", seat: args[0]!, model: model.data } };
}
