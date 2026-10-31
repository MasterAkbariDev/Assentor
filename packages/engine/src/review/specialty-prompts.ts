import type { ReviewerSpecialty } from "../agents/index.js";
import { builtinPromptDir, PromptLibrary } from "../prompts/index.js";

export type SpecialtyPromptKey = Exclude<ReviewerSpecialty, "adjudicator">;

const SPECIALTY_KEYS: readonly SpecialtyPromptKey[] = [
  "architecture",
  "code",
  "testing",
  "security",
  "performance",
  "ui",
  "general",
];

/**
 * Per-specialty addenda layered on DEFAULT_AGENT_PROFILES instructions.
 * Every finding must cite concrete evidence — no vague opinions.
 *
 * The text lives in the built-in prompt library
 * (`prompts/builtin/specialty-<key>.md`, T03-01). Only the built-in layer is
 * read here; user/project overrides apply where a run loads the full library.
 */
export const SPECIALTY_PROMPT_ADDENDA: Readonly<Record<SpecialtyPromptKey, string>> =
  lazySpecialtyAddenda();

/**
 * Read the files on first use, not at import, so commands that never review
 * (doctor, config) still run on a broken install.
 */
function lazySpecialtyAddenda(): Record<SpecialtyPromptKey, string> {
  let loaded: Record<SpecialtyPromptKey, string> | undefined;
  const addenda = {} as Record<SpecialtyPromptKey, string>;
  for (const key of SPECIALTY_KEYS) {
    Object.defineProperty(addenda, key, {
      enumerable: true,
      get: () => (loaded ??= loadSpecialtyAddenda())[key],
    });
  }
  return Object.freeze(addenda);
}

function loadSpecialtyAddenda(): Record<SpecialtyPromptKey, string> {
  const library = PromptLibrary.loadBuiltinSync();
  const addenda = {} as Record<SpecialtyPromptKey, string>;
  for (const key of SPECIALTY_KEYS) {
    const prompt = library.get(`specialty-${key}`);
    if (!prompt) {
      const reason = library.errors.find((error) =>
        error.file.endsWith(`specialty-${key}.md`),
      );
      throw new Error(
        `Built-in prompt specialty-${key} is missing from ${builtinPromptDir()}` +
          (reason ? `: ${reason.message}` : "") +
          ". Reinstall Assentor.",
      );
    }
    addenda[key] = prompt.body;
  }
  return addenda;
}

export function specialtyAddendum(
  specialty?: ReviewerSpecialty | string,
): string {
  if (!specialty || specialty === "adjudicator") {
    return SPECIALTY_PROMPT_ADDENDA.general;
  }
  const key = specialty as SpecialtyPromptKey;
  return SPECIALTY_PROMPT_ADDENDA[key] ?? SPECIALTY_PROMPT_ADDENDA.general;
}

export function expandProfileInstructions(
  baseInstructions: string,
  specialty?: ReviewerSpecialty | string,
): string {
  return `${baseInstructions.trim()}\n\n${specialtyAddendum(specialty)}`;
}
