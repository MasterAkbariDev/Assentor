import { estimateTokens } from "../usage/tokens.js";

/**
 * Context packer (TE-03): builds what a seat sees from typed, prioritised
 * sections under a token budget. Lower priority sections shrink first and every
 * cut leaves an explicit marker, so the seat knows what it did not get. Blocks
 * that are identical across sections are sent once. The token count is the
 * shared estimator from `usage/tokens.ts` (the one `bench:tokens` uses).
 */

export type SectionKind = "task" | "constraints" | "diff" | "failing-test" | "excerpt" | "summary" | "history";

/** Which part of a section survives a cut. `all` = never cut (until nothing else is left to cut). */
export type Keep = "all" | "start" | "end" | "both";

export interface ContextSection {
  /** Unique within one pack. */
  id: string;
  kind: SectionKind;
  text: string;
  /** Higher survives longer. Default: by kind. */
  priority?: number;
  /** Default: by kind. */
  keep?: Keep;
  /** Heading line rendered above the text (counted against the budget). */
  title?: string;
  /**
   * Send a block that another section already carries only once. Default: yes, except for `diff` and
   * `excerpt` sections, where two copies of the same code can be a finding the reader must see.
   */
  dedupe?: boolean;
}

const KIND_DEFAULTS: Record<SectionKind, { priority: number; keep: Keep }> = {
  task: { priority: 100, keep: "all" },
  constraints: { priority: 90, keep: "all" },
  diff: { priority: 80, keep: "start" },
  "failing-test": { priority: 70, keep: "both" },
  excerpt: { priority: 50, keep: "start" },
  summary: { priority: 40, keep: "end" },
  history: { priority: 30, keep: "end" },
};

export interface PackOptions {
  budgetTokens: number;
  /** Model id for the estimator's per-model factor. */
  model?: string;
  /** Unchanged lines kept around each changed line when a diff section has to shrink. Default 3. */
  diffContext?: number;
}

export interface PackedContext {
  /** All sections in the order given, separated by a blank line. At most `budgetTokens`. */
  text: string;
  tokens: number;
  /** Final text of each section by id (without its title); `""` when a section was empty. */
  parts: Record<string, string>;
  /** Sections that were cut, with the lines dropped. */
  omitted: Array<{ id: string; lines: number }>;
  /** Sections that lost a block because the same block is already in another section. */
  deduped: string[];
  /** True only when the budget is smaller than the headings and markers: `text` was cut mid-way. */
  clipped: boolean;
}

/** Blocks shorter than this are not worth a pointer (`none`, `ok`, a bare heading). */
const MIN_DEDUPE_CHARS = 60;

export const omissionMarker = (lines: number) => `[… ${lines} ${lines === 1 ? "line" : "lines"} omitted — ask to see more]`;

/** Keep the changed lines of a unified diff and `context` lines around them; skipped runs become markers. */
export function compactDiff(diff: string, context = 3): string {
  const lines = diff.split("\n");
  const isChange = (line: string) => /^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line);
  const isHeader = (line: string) => /^(diff --git|index |--- |\+\+\+ |@@)/.test(line);
  const keep = lines.map(isHeader);
  lines.forEach((line, i) => {
    if (!isChange(line)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) keep[j] = true;
  });
  const out: string[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped > 0) out.push(omissionMarker(skipped));
    skipped = 0;
  };
  lines.forEach((line, i) => {
    if (keep[i]) {
      flush();
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  flush();
  return out.join("\n");
}

interface Working {
  section: ContextSection;
  priority: number;
  keep: Keep;
  lines: string[];
  /** Lines kept from the start / end. */
  head: number;
  tail: number;
  /** Lines dropped by diff compaction (they left a marker in `lines`). */
  compacted: number;
  index: number;
}

function renderBody(w: Working): string {
  const cut = w.lines.length - w.head - w.tail;
  if (cut <= 0) return w.lines.join("\n");
  const marker = omissionMarker(cut);
  return [...w.lines.slice(0, w.head), marker, ...w.lines.slice(w.lines.length - w.tail)].join("\n");
}

function renderSection(w: Working): string {
  const body = renderBody(w);
  return w.section.title ? `${w.section.title}\n${body}` : body;
}

const join = (works: Working[]) =>
  works
    .map(renderSection)
    .filter((part) => part !== "")
    .join("\n\n");

/** Set how many lines of `w` to keep (`keep` decides from which end). */
function setKept(w: Working, kept: number): void {
  const n = w.lines.length;
  const k = Math.max(0, Math.min(n, kept));
  if (w.keep === "end") {
    w.head = 0;
    w.tail = k;
  } else if (w.keep === "both") {
    w.head = Math.ceil(k / 2);
    w.tail = Math.floor(k / 2);
  } else {
    w.head = k;
    w.tail = 0;
  }
}

/**
 * Pack `sections` into at most `budgetTokens`. Order of work: dedupe identical
 * blocks; if still over budget, shrink sections from the lowest priority up
 * (diffs first lose context lines around their changes, then lines like any
 * other section); sections marked `keep: "all"` are cut last, as a last resort.
 * The result never exceeds the budget.
 */
export function packContext(sections: readonly ContextSection[], options: PackOptions): PackedContext {
  const { model = "" } = options;
  const budget = Math.max(0, Math.floor(options.budgetTokens));
  const tokensOf = (text: string) => estimateTokens(text, model);
  const ids = new Set<string>();
  const works: Working[] = sections.map((section, index) => {
    if (ids.has(section.id)) throw new Error(`context section "${section.id}" appears twice`);
    ids.add(section.id);
    const defaults = KIND_DEFAULTS[section.kind];
    const lines = section.text.length ? section.text.split("\n") : [];
    return { section, priority: section.priority ?? defaults.priority, keep: section.keep ?? defaults.keep, lines, head: lines.length, tail: 0, compacted: 0, index };
  });

  // 1. Dedupe: the highest priority copy of a block keeps it (ties: the earlier section). Test output and
  // history also lose their own repeats (warnings and stack frames repeat verbatim); code never does.
  const deduped: string[] = [];
  const seen = new Map<string, string>();
  for (const w of [...works].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    const kind = w.section.kind;
    if (!(w.section.dedupe ?? (kind !== "diff" && kind !== "excerpt"))) continue;
    const own = new Set<string>();
    let changed = false;
    const next = w.section.text.split(/\n{2,}/).map((block) => {
      const key = block.trim();
      if (key.length < MIN_DEDUPE_CHARS) return block;
      const owner = seen.get(key);
      if (owner !== undefined && owner !== w.section.id) {
        changed = true;
        return `[… same text as "${owner}" omitted]`;
      }
      if (own.has(key) && (kind === "failing-test" || kind === "history")) {
        changed = true;
        return "[… repeated block omitted]";
      }
      own.add(key);
      seen.set(key, w.section.id);
      return block;
    });
    if (changed) {
      deduped.push(w.section.id);
      w.lines = next.join("\n\n").split("\n");
      w.head = w.lines.length;
    }
  }

  // 2. Shrink, lowest priority first (ties: the larger, then the later section), until it fits.
  const fits = () => tokensOf(join(works)) <= budget;
  const order = [...works].sort((a, b) => a.priority - b.priority || b.section.text.length - a.section.text.length || b.index - a.index);
  const shrink = (w: Working) => {
    if (fits() || w.lines.length === 0) return;
    if (w.section.kind === "diff") {
      const compact = compactDiff(w.lines.join("\n"), options.diffContext ?? 3);
      if (compact.split("\n").length < w.lines.length) {
        const kept = compact.split("\n");
        w.compacted = w.lines.length - kept.filter((line) => !line.startsWith("[… ")).length;
        w.lines = kept;
        w.head = w.lines.length;
        w.tail = 0;
        if (fits()) return;
      }
    }
    // Largest number of kept lines that fits (tokens only grow with kept lines).
    const whole = renderSection(w).length;
    let low = 0;
    let high = w.lines.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      setKept(w, mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    setKept(w, low);
    // A marker longer than the text it replaces saves nothing.
    if (renderSection(w).length >= whole) setKept(w, w.lines.length);
  };
  for (const w of order.filter((x) => x.keep !== "all")) shrink(w);
  for (const w of order.filter((x) => x.keep === "all")) shrink(w);

  let text = join(works);
  // Titles and markers alone can exceed a tiny budget: the budget still wins.
  let clipped = false;
  if (tokensOf(text) > budget) {
    clipped = true;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (tokensOf(text.slice(0, mid)) <= budget) low = mid;
      else high = mid - 1;
    }
    text = text.slice(0, low);
  }

  const dropped = (w: Working) => w.compacted + Math.max(0, w.lines.length - w.head - w.tail);
  return {
    text,
    tokens: tokensOf(text),
    // Best effort when `clipped` (only a budget smaller than the headings and markers): sections shrink to a marker.
    parts: Object.fromEntries(works.map((w) => [w.section.id, clipped && w.lines.length ? omissionMarker(w.lines.length) : renderBody(w)])),
    omitted: works.flatMap((w) => (dropped(w) > 0 || (clipped && w.lines.length) ? [{ id: w.section.id, lines: clipped ? w.lines.length : dropped(w) }] : [])),
    deduped,
    clipped,
  };
}
