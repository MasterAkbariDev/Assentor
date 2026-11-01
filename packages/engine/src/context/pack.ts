import { estimateTokens } from "../usage/tokens.js";

/**
 * Context packer (TE-03): builds what a seat sees from typed, prioritised
 * sections. Two independent parts:
 *
 * - Lossless: blocks that are identical across sections (or repeated in test
 *   output / history) are sent once, with a marker that shows the count.
 * - Budget cuts, only when `budgetTokens` is set: lower priority sections shrink
 *   first and every cut leaves an explicit `[… N lines omitted]` marker. Code
 *   fences are always closed and reopened around a cut.
 *
 * The token count is the shared estimator from `usage/tokens.ts` (the one
 * `bench:tokens` uses).
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
  /** Render the text inside a code fence (the fence lines are never cut). */
  fence?: boolean;
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
  /** Cut to at most this many tokens. Unset: nothing is cut, only identical blocks are merged. */
  budgetTokens?: number;
  /** Model id for the estimator's per-model factor. */
  model?: string;
  /** Unchanged lines kept around each changed line when a diff section has to shrink. Default 3. */
  diffContext?: number;
  /** Added to every omission marker, e.g. "request via evidenceRequests". */
  hint?: string;
}

export interface PackedContext {
  /** All sections in the order given, separated by a blank line. At most `budgetTokens` when one is set. */
  text: string;
  tokens: number;
  /** Final text of each section by id (without its title); `""` when a section was empty. */
  parts: Record<string, string>;
  /** Sections that were cut, with the lines dropped. */
  omitted: Array<{ id: string; lines: number }>;
  /** Sections that lost a block because the same block is already sent. */
  deduped: string[];
  /** True only when the budget is smaller than the headings and markers: `text` was cut mid-way. */
  clipped: boolean;
}

/** Blocks shorter than this are not worth a pointer (`none`, `ok`, a bare heading). */
const MIN_DEDUPE_CHARS = 60;
const FENCE = "```";

export const omissionMarker = (lines: number, hint?: string) =>
  `[… ${lines} ${lines === 1 ? "line" : "lines"} omitted${hint ? ` — ${hint}` : ""}]`;

const isFence = (line: string) => line.trimStart().startsWith(FENCE);
/** Whether `lines[0..upto)` end inside a code fence. */
const insideFence = (lines: readonly string[], upto: number) => lines.slice(0, upto).filter(isFence).length % 2 === 1;
/** Text with a fence left open gets it closed. */
export const closeOpenFence = (text: string) => (text.split("\n").filter(isFence).length % 2 === 1 ? `${text}\n${FENCE}` : text);

/** Keep the changed lines of a unified diff and `context` lines around them; skipped runs become markers. */
export function compactDiff(diff: string, context = 3, hint?: string): string {
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
    if (skipped > 0) out.push(omissionMarker(skipped, hint));
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
  /** Lines dropped by diff compaction or a character cut (they left a marker in `lines`). */
  compacted: number;
  index: number;
}

function renderBody(w: Working, hint?: string): string {
  const n = w.lines.length;
  const cut = n - w.head - w.tail;
  if (cut <= 0) return w.lines.join("\n");
  const out = w.lines.slice(0, w.head);
  // A fence left open by the cut is closed before the marker and reopened before the tail.
  if (!w.section.fence && insideFence(w.lines, w.head)) out.push(FENCE);
  out.push(omissionMarker(cut, hint));
  if (!w.section.fence && w.tail > 0 && insideFence(w.lines, n - w.tail)) out.push(FENCE);
  out.push(...w.lines.slice(n - w.tail));
  return out.join("\n");
}

function renderSection(w: Working, hint?: string): string {
  const body = renderBody(w, hint);
  const inner = w.section.fence ? `${FENCE}\n${body}\n${FENCE}` : body;
  return w.section.title ? `${w.section.title}\n${inner}` : inner;
}

/** Set how many lines of `w` to keep (`keep` decides from which end). */
function setKept(w: Working, kept: number): void {
  const k = Math.max(0, Math.min(w.lines.length, kept));
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
 * Pack `sections`. Always: merge identical blocks. With `budgetTokens`: shrink sections from the lowest
 * priority up (diffs first lose context lines around their changes, then lines like any other section; a
 * section whose lines do not fit is cut by characters, keeping its tail); sections marked `keep: "all"` are
 * cut last, as a last resort. The result never exceeds the budget.
 */
export function packContext(sections: readonly ContextSection[], options: PackOptions = {}): PackedContext {
  const { model = "", hint } = options;
  const budget = options.budgetTokens === undefined ? Infinity : Math.max(0, Math.floor(options.budgetTokens));
  const tokensOf = (text: string) => estimateTokens(text, model);
  const ids = new Set<string>();
  const works: Working[] = sections.map((section, index) => {
    if (ids.has(section.id)) throw new Error(`context section "${section.id}" appears twice`);
    ids.add(section.id);
    const defaults = KIND_DEFAULTS[section.kind];
    const lines = section.text.length ? section.text.split("\n") : [];
    return { section, priority: section.priority ?? defaults.priority, keep: section.keep ?? defaults.keep, lines, head: lines.length, tail: 0, compacted: 0, index };
  });
  const dedupes = (w: Working) => w.section.dedupe ?? (w.section.kind !== "diff" && w.section.kind !== "excerpt");

  // 1. Merge identical blocks: the highest priority copy keeps the text (ties: the earlier section). Test output
  // and history also lose their own repeats (output repeats verbatim); code is never merged unless asked for.
  const deduped: string[] = [];
  const blocksOf = (w: Working) => w.section.text.split(/\n{2,}/);
  const total = new Map<string, number>();
  for (const w of works.filter(dedupes)) {
    for (const block of blocksOf(w)) {
      const key = block.trim();
      if (key.length >= MIN_DEDUPE_CHARS) total.set(key, (total.get(key) ?? 0) + 1);
    }
  }
  const owners = new Map<string, string>();
  for (const w of [...works].filter(dedupes).sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    const within = w.section.kind === "failing-test" || w.section.kind === "history";
    const blocks: Array<string | undefined> = blocksOf(w);
    const firstRepeat = new Map<string, number>();
    const repeats = new Map<string, number>();
    const own = new Set<string>();
    let changed = false;
    blocks.forEach((block, i) => {
      const key = block!.trim();
      if (key.length < MIN_DEDUPE_CHARS) return;
      const owner = owners.get(key);
      if (owner !== undefined && owner !== w.section.id) {
        blocks[i] = `[… same text as "${owner}" (${total.get(key)} copies)]`;
        changed = true;
      } else if (own.has(key) && within) {
        if (!firstRepeat.has(key)) firstRepeat.set(key, i);
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
        blocks[i] = undefined;
        changed = true;
      } else {
        own.add(key);
        owners.set(key, w.section.id);
      }
    });
    for (const [key, i] of firstRepeat) blocks[i] = `[… the block above repeats ${repeats.get(key)} more ${repeats.get(key) === 1 ? "time" : "times"}]`;
    const next = blocks.filter((block): block is string => block !== undefined);
    if (changed) {
      deduped.push(w.section.id);
      w.lines = next.join("\n\n").split("\n");
      w.head = w.lines.length;
    }
  }

  const join = () =>
    works
      .map((w) => renderSection(w, hint))
      .filter((part) => part !== "")
      .join("\n\n");

  // 2. Shrink, lowest priority first (ties: the larger, then the later section), until it fits.
  if (budget !== Infinity) {
    const fits = () => tokensOf(join()) <= budget;
    const order = [...works].sort((a, b) => a.priority - b.priority || b.section.text.length - a.section.text.length || b.index - a.index);
    const shrink = (w: Working) => {
      if (fits() || w.lines.length === 0) return;
      const whole = renderSection(w, hint).length;
      const snapshot = { lines: w.lines, head: w.head, tail: w.tail, compacted: w.compacted };
      if (w.section.kind === "diff") {
        const compact = compactDiff(w.lines.join("\n"), options.diffContext ?? 3, hint);
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
      let low = 0;
      let high = w.lines.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        setKept(w, mid);
        if (fits()) low = mid;
        else high = mid - 1;
      }
      setKept(w, low);
      if (low === 0) {
        // Not even one line fits (one very long line): cut by characters and keep the tail.
        const text = w.lines.join("\n");
        const original = w.lines.length;
        const attempt = (chars: number) => {
          w.lines = [`[… ${text.length - chars} characters omitted, tail kept${hint ? ` — ${hint}` : ""}]`, text.slice(text.length - chars)];
          w.head = w.lines.length;
          w.tail = 0;
        };
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          attempt(mid);
          if (fits()) lo = mid;
          else hi = mid - 1;
        }
        attempt(lo);
        w.compacted = original;
      }
      // A marker longer than the text it replaces saves nothing.
      if (renderSection(w, hint).length >= whole) Object.assign(w, snapshot);
    };
    for (const w of order.filter((x) => x.keep !== "all")) shrink(w);
    for (const w of order.filter((x) => x.keep === "all")) shrink(w);
  }

  let text = join();
  // Titles and markers alone can exceed a tiny budget: the budget still wins (and no fence is left open).
  let clipped = false;
  if (tokensOf(text) > budget) {
    clipped = true;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (tokensOf(closeOpenFence(text.slice(0, mid))) <= budget) low = mid;
      else high = mid - 1;
    }
    text = closeOpenFence(text.slice(0, low));
  }

  const dropped = (w: Working) => w.compacted + Math.max(0, w.lines.length - w.head - w.tail);
  return {
    text,
    tokens: tokensOf(text),
    // Best effort when `clipped` (only a budget smaller than the headings and markers): sections shrink to a marker.
    parts: Object.fromEntries(works.map((w) => [w.section.id, clipped && w.lines.length ? omissionMarker(w.lines.length, hint) : renderBody(w, hint)])),
    omitted: works.flatMap((w) => (dropped(w) > 0 || (clipped && w.lines.length) ? [{ id: w.section.id, lines: clipped ? w.lines.length : dropped(w) }] : [])),
    deduped,
    clipped,
  };
}
