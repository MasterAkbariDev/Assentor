import { packContext, type ContextSection, type SectionKind } from "./pack.js";

/** How each prompt variable ranks when the context has to shrink. Unlisted variables pass through untouched. */
const VARIABLE_KINDS: Record<string, SectionKind> = {
  goal: "task",
  subtask: "task",
  proposal: "task",
  acceptanceCriteria: "constraints",
  critiques: "constraints",
  diff: "diff",
  conflicts: "diff",
  proposals: "diff",
  testOutput: "failing-test",
  errorLog: "failing-test",
  evidence: "excerpt",
  projectSummary: "summary",
  reviewFeedback: "history",
  driverOutput: "history",
};

/** A list item's id in the pack: its label ("Proposal B") when it has one, so a pointer to a duplicate reads well. */
const itemId = (name: string, item: unknown, i: number) => {
  const label = (item as { label?: unknown } | null)?.label;
  return typeof label === "string" && label ? label : `${name}.${i}`;
};

/**
 * Pack the context variables of a prompt (string values, and the `text` of list items such as
 * proposals) under `budgetTokens`. Short control values (round, label, …) pass through. The role
 * prompt itself is not counted: the budget is for the task context the caller supplies.
 */
export function packPromptVariables<V extends Record<string, unknown>>(
  vars: V,
  options: { budgetTokens: number; model?: string; kinds?: Record<string, SectionKind> },
): V {
  const kinds = { ...VARIABLE_KINDS, ...options.kinds };
  const sections: ContextSection[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  for (const [name, value] of Object.entries(vars)) {
    const kind = kinds[name];
    if (!kind) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const body = text(item) ?? text((item as { text?: unknown } | null)?.text);
        if (body !== undefined) sections.push({ id: itemId(name, item, i), kind, text: body, dedupe: true });
      });
    } else if (text(value) !== undefined) {
      sections.push({ id: name, kind, text: value as string });
    }
  }
  const { parts } = packContext(sections, { budgetTokens: options.budgetTokens, ...(options.model ? { model: options.model } : {}) });
  const out: Record<string, unknown> = { ...vars };
  for (const [name, value] of Object.entries(vars)) {
    if (Array.isArray(value)) {
      out[name] = value.map((item, i) => {
        const part = parts[itemId(name, item, i)];
        if (part === undefined) return item;
        return typeof item === "string" ? part : { ...(item as object), text: part };
      });
    } else if (parts[name] !== undefined) {
      out[name] = parts[name];
    }
  }
  return out as V;
}
