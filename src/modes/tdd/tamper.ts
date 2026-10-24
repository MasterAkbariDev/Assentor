/**
 * Test-tamper detection for TDD mode (T02B-12). Pure functions, no I/O.
 *
 * Paths are repo-relative. Backslashes are normalized to "/" before matching.
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
  return filePath.replace(/\\/g, "/");
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

/** A locked test changed by the coder and not in `approvedChanges` is tampered. */
export function detectTamper(input: TamperInput): TamperResult {
  const locked = new Set(input.lockedTests.map(normalizePath));
  const approved = new Set((input.approvedChanges ?? []).map(normalizePath));

  const tampered: string[] = [];
  for (const changed of input.coderChangedFiles.map(normalizePath)) {
    if (locked.has(changed) && !approved.has(changed) && !tampered.includes(changed)) {
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
