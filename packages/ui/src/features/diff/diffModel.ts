export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  /** `index`, `---`, `+++`, mode and "Binary files" lines before the first hunk. */
  meta: string[];
  hunks: DiffHunk[];
}

/** Path of `diff --git a/x b/y` (the b side). Quoted or odd names fall back to the raw text. */
function pathOf(header: string): string {
  const m = /^diff --git a\/.* b\/(.*)$/.exec(header);
  return m?.[1] ?? header.slice("diff --git ".length);
}

/** Split `git diff` output into files and hunks. Pure text; nothing is interpreted as markup. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: pathOf(line), meta: [line], hunks: [] };
      hunk = undefined;
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (!hunk) {
      file.meta.push(line);
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line });
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line });
    } else {
      hunk.lines.push({ kind: "ctx", text: line });
    }
  }
  // split("\n") leaves one empty tail after the final newline.
  for (const f of files) {
    const tail = f.hunks.at(-1)?.lines ?? f.meta;
    if (tail.at(-1) === "" || (tail.at(-1) as DiffLine | undefined)?.text === "") tail.pop();
  }
  return files;
}
