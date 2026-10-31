/**
 * Test-tamper detection for TDD mode (T02B-12). Pure functions, no I/O.
 *
 * Paths are repo-relative. Backslashes are normalized to "/" and a leading "./"
 * is stripped before matching. Glob matching (isTestFile, lockTests) is case-sensitive;
 * the tamper comparison in detectTamper is case-insensitive, because macOS and
 * Windows filesystems are. Tampered entries keep the coder's spelling.
 * Glob rules:
 * - `**` followed by `/` matches zero or more path segments.
 * - A trailing `/**` matches anything under that directory.
 * - `*` matches within one segment and never crosses "/".
 * - `?` matches one character that is not "/".
 * - Every other character is literal.
 */

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "tests/**",
  "test/**",
  "**/*_test.go",
  "**/test_*.py",
];

/**
 * Files that decide what the test command runs or whether it exits 0 (by basename, any depth).
 * The one list shared by TDD mode (a change to one, or a new one, is tampering) and red-team
 * mode (an attacker may not add one, a builder may not change one). Red-team compares package.json by its runner keys
 * instead of treating every edit as tampering (see `isRunnerFile`).
 * The merged list is stricter for both modes: TDD now also protects go.mod, setup.py, tsconfig*.json, babel/.babelrc,
 * global-setup and *.setup.* files; red-team now also protects justfile, noxfile.py and .gitignore.
 */
export const RUNNER_CONFIG =
  /(?:^|\/)(?:[^/]*(?:vitest|vite|jest|playwright|cypress|ava)\.(?:config|workspace)\.[^/]*|(?:vitest|vite|jest|playwright|karma|mocha|ava|cypress|babel)\.(?:config|workspace|setup)(?:\.[^/]*)?|karma\.conf\.[^/]*|\.mocharc(?:\.[^/]*)?|\.babelrc(?:\.[^/]*)?|setuptests\.[^/]*|global-?setup\.[^/]*|[^/]+\.setup\.[^/.]+|package\.json|\.?pytest\.ini|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|conftest\.py|noxfile\.py|cargo\.toml|go\.mod|tsconfig[^/]*\.json|makefile|gnumakefile|justfile|\.gitignore)$/i;

/** Whether a path is on the shared runner list, package.json excluded (red-team checks it by runner keys). */
export const isRunnerFile = (filePath: string): boolean =>
  RUNNER_CONFIG.test(normalizePath(filePath)) && !/(?:^|\/)package\.json$/i.test(normalizePath(filePath));

export interface TamperInput {
  /** Test files the test writer produced; the coder must not change them. */
  lockedTests: string[];
  /** Files the coder changed. */
  coderChangedFiles: string[];
  /** Locked test files the coder is explicitly allowed to change. */
  approvedChanges?: string[];
}

export interface TamperResult {
  /** Normalized paths of locked tests the coder changed without approval, in input order. */
  tampered: string[];
  ok: boolean;
}

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Whether a repo-relative path matches any test pattern (default: DEFAULT_TEST_PATTERNS). */
export function isTestFile(
  filePath: string,
  patterns: readonly string[] = DEFAULT_TEST_PATTERNS,
): boolean {
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** The subset of the test writer's changed files that are test files. */
export function lockTests(
  testWriterChangedFiles: string[],
  patterns: readonly string[] = DEFAULT_TEST_PATTERNS,
): string[] {
  return testWriterChangedFiles.filter((file) => isTestFile(file, patterns));
}

/**
 * A locked test changed by the coder and not in `approvedChanges` is tampered.
 * Comparison is case-insensitive; each file is reported once, with the coder's spelling.
 */
export function detectTamper(input: TamperInput): TamperResult {
  const key = (filePath: string) => normalizePath(filePath).toLowerCase();
  const locked = new Set(input.lockedTests.map(key));
  const approved = new Set((input.approvedChanges ?? []).map(key));

  const tampered: string[] = [];
  const reported = new Set<string>();
  for (const changed of input.coderChangedFiles.map(normalizePath)) {
    const id = changed.toLowerCase();
    if (locked.has(id) && !approved.has(id) && !reported.has(id)) {
      reported.add(id);
      tampered.push(changed);
    }
  }
  return { tampered, ok: tampered.length === 0 };
}

/** Convert a glob to an anchored RegExp. Operates on normalized ("/") patterns. */
function globToRegExp(glob: string): RegExp {
  const pattern = normalizePath(glob);
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      source += "/.*";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeRegExp(pattern[i]!);
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
