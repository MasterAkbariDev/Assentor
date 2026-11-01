import { z } from "zod";
import { PromptLibrary } from "../prompts/library.js";

/**
 * Output styles (TE-02). `normal` is the default and adds nothing, so prompts and
 * output stay byte-identical to before. `concise` and `verbose` put one built-in
 * fragment (`prompts/builtin/style-<style>.md`) at the front of each seat's own
 * text. Everything before it is the same for every seat, so the fragment sits at
 * the same offset on every call and stays cache-friendly.
 */
export const OUTPUT_STYLES = ["concise", "normal", "verbose"] as const;
export type OutputStyle = (typeof OUTPUT_STYLES)[number];
export const DEFAULT_OUTPUT_STYLE: OutputStyle = "normal";
export const OutputStyleSchema = z.enum(OUTPUT_STYLES);

const fragments = new Map<OutputStyle, string>();

/** Fragment text for a style, read once from the built-in library. Empty for `normal`. */
export function styleFragment(style: OutputStyle = DEFAULT_OUTPUT_STYLE): string {
  if (style === "normal") return "";
  let text = fragments.get(style);
  if (text === undefined) {
    const prompt = PromptLibrary.loadBuiltinSync().get(`style-${style}`);
    if (!prompt) {
      throw new Error(`Built-in prompt style-${style} is missing. Reinstall Assentor.`);
    }
    text = prompt.body;
    fragments.set(style, text);
  }
  return text;
}

/** `text` with the style fragment in front of it. `normal` returns `text` unchanged. */
export function withOutputStyle(text: string, style: OutputStyle = DEFAULT_OUTPUT_STYLE): string {
  const fragment = styleFragment(style);
  return fragment ? `${fragment}\n\n${text}` : text;
}
