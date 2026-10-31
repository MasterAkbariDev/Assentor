import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_PATTERNS,
  detectTamper,
  isTestFile,
  lockTests,
  normalizePath,
} from "../../packages/engine/src/modes/tdd/tamper.js";

describe("isTestFile default patterns", () => {
  it.each([
    ["**/*.test.*", "src/foo.test.ts", "src/footest.ts"],
    ["**/*.spec.*", "src/foo.spec.ts", "src/inspector.ts"],
    ["**/__tests__/**", "src/__tests__/a.ts", "src/tests.ts"],
    ["tests/**", "tests/a/b.ts", "src/tests.ts"],
    ["test/**", "test/a.ts", "tests/a.ts"],
    ["**/*_test.go", "pkg/foo_test.go", "pkg/footest.go"],
    ["**/test_*.py", "tests/test_x.py", "src/xtest_x.py"],
  ])("%s: matches %s and not %s", (pattern, positive, negative) => {
    expect(DEFAULT_TEST_PATTERNS).toContain(pattern);
    // Check each pattern on its own: another default pattern may match the negative path.
    expect(isTestFile(positive, [pattern])).toBe(true);
    expect(isTestFile(negative, [pattern])).toBe(false);
  });

  it("the spec's examples: src/foo.test.ts matches, src/footest.ts does not", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/footest.ts")).toBe(false);
  });

  it("tests/a/b.ts matches and src/tests.ts does not", () => {
    expect(isTestFile("tests/a/b.ts")).toBe(true);
    expect(isTestFile("src/tests.ts")).toBe(false);
  });

  it("a top-level test file matches **/ with zero directories", () => {
    expect(isTestFile("foo.test.ts")).toBe(true);
  });

  it("a non-test source file is not a test", () => {
    expect(isTestFile("src/app.ts")).toBe(false);
    expect(isTestFile("src/average.ts")).toBe(false);
  });
});

describe("Windows paths", () => {
  it("backslashes are normalized before matching", () => {
    expect(isTestFile("tests\\a\\b.ts")).toBe(true);
    expect(isTestFile("src\\foo.test.ts")).toBe(true);
    expect(isTestFile("src\\footest.ts")).toBe(false);
  });

  it("detectTamper treats backslash and slash paths as the same file", () => {
    const result = detectTamper({
      lockedTests: ["tests/a/b.ts"],
      coderChangedFiles: ["tests\\a\\b.ts"],
    });
    expect(result).toEqual({ tampered: ["tests/a/b.ts"], ok: false });
  });
});

describe("custom patterns", () => {
  it("* does not cross a slash and ? is one non-slash character", () => {
    expect(isTestFile("src/a.spec.ts", ["src/*.spec.ts"])).toBe(true);
    expect(isTestFile("src/deep/a.spec.ts", ["src/*.spec.ts"])).toBe(false);
    expect(isTestFile("src/ab.ts", ["src/a?.ts"])).toBe(true);
    expect(isTestFile("src/a/b.ts", ["src/a?b.ts"])).toBe(false);
  });

  it("regex metacharacters in a pattern are literal", () => {
    expect(isTestFile("src/a+b(c).ts", ["src/a+b(c).ts"])).toBe(true);
    expect(isTestFile("src/aab(c).ts", ["src/a+b(c).ts"])).toBe(false);
  });
});

describe("lockTests", () => {
  it("keeps only the test files from the test writer's changes", () => {
    expect(
      lockTests(["src/foo.test.ts", "src/foo.ts", "tests/x.ts", "docs/readme.md"]),
    ).toEqual(["src/foo.test.ts", "tests/x.ts"]);
  });
});

describe("detectTamper", () => {
  it("a locked test changed by the coder is tampered", () => {
    expect(
      detectTamper({
        lockedTests: ["src/foo.test.ts"],
        coderChangedFiles: ["src/foo.ts", "src/foo.test.ts"],
      }),
    ).toEqual({ tampered: ["src/foo.test.ts"], ok: false });
  });

  it("an approved change to a locked test is not tampering", () => {
    expect(
      detectTamper({
        lockedTests: ["src/foo.test.ts"],
        coderChangedFiles: ["src/foo.test.ts"],
        approvedChanges: ["src/foo.test.ts"],
      }),
    ).toEqual({ tampered: [], ok: true });
  });

  it("only the unapproved locked tests are reported", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.ts", "tests/b.ts"],
        coderChangedFiles: ["tests/a.ts", "tests/b.ts"],
        approvedChanges: ["tests/a.ts"],
      }),
    ).toEqual({ tampered: ["tests/b.ts"], ok: false });
  });

  it("non-test files the coder changes are ignored", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.ts"],
        coderChangedFiles: ["src/app.ts", "src/average.ts"],
      }),
    ).toEqual({ tampered: [], ok: true });
  });

  it("a locked test the coder did not touch is fine", () => {
    expect(
      detectTamper({ lockedTests: ["tests/a.ts"], coderChangedFiles: [] }),
    ).toEqual({ tampered: [], ok: true });
  });

  it("reports each tampered file once", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.ts"],
        coderChangedFiles: ["tests/a.ts", "tests/a.ts"],
      }),
    ).toEqual({ tampered: ["tests/a.ts"], ok: false });
  });
});

describe("leading ./ is stripped", () => {
  it("normalizePath strips one, repeated, and backslash-form ./ prefixes", () => {
    expect(normalizePath("./tests/a.ts")).toBe("tests/a.ts");
    expect(normalizePath("././tests/a.ts")).toBe("tests/a.ts");
    expect(normalizePath(".\\tests\\a.ts")).toBe("tests/a.ts");
    expect(normalizePath(".github/x.yml")).toBe(".github/x.yml");
  });

  it("isTestFile matches single, repeated, and backslash ./ paths", () => {
    expect(isTestFile("./tests/a.ts")).toBe(true);
    expect(isTestFile("././tests/a.ts")).toBe(true);
    expect(isTestFile(".\\tests\\a.ts")).toBe(true);
    expect(isTestFile("./src/footest.ts")).toBe(false);
  });

  it("detectTamper treats ./ forms of a locked test as the same file", () => {
    expect(
      detectTamper({ lockedTests: ["tests/a.ts"], coderChangedFiles: ["./tests/a.ts"] }),
    ).toEqual({ tampered: ["tests/a.ts"], ok: false });
    expect(
      detectTamper({ lockedTests: ["tests/a.ts"], coderChangedFiles: ["././tests/a.ts"] }),
    ).toEqual({ tampered: ["tests/a.ts"], ok: false });
    expect(
      detectTamper({ lockedTests: ["tests/a.ts"], coderChangedFiles: [".\\tests\\a.ts"] }),
    ).toEqual({ tampered: ["tests/a.ts"], ok: false });
  });

  it("a ./ prefix on lockedTests or approvedChanges still matches", () => {
    expect(
      detectTamper({
        lockedTests: ["./tests/a.ts"],
        coderChangedFiles: ["tests/a.ts"],
        approvedChanges: ["././tests/a.ts"],
      }),
    ).toEqual({ tampered: [], ok: true });
  });
});

describe("case-insensitive tamper comparison", () => {
  it("a case variant of a locked test is tampered and keeps the coder's spelling", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.test.ts"],
        coderChangedFiles: ["Tests/A.test.ts"],
      }),
    ).toEqual({ tampered: ["Tests/A.test.ts"], ok: false });
  });

  it("an approval in a different case approves the locked test", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.test.ts"],
        coderChangedFiles: ["tests/a.test.ts"],
        approvedChanges: ["TESTS/a.test.ts"],
      }),
    ).toEqual({ tampered: [], ok: true });
  });

  it("case variants are de-duplicated, keeping the first spelling in coder order", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.test.ts", "tests/b.test.ts"],
        coderChangedFiles: ["Tests/A.test.ts", "tests/a.test.ts", "TESTS/B.TEST.TS", "tests/b.test.ts"],
      }),
    ).toEqual({ tampered: ["Tests/A.test.ts", "TESTS/B.TEST.TS"], ok: false });
  });

  it("glob matching stays case-sensitive", () => {
    expect(isTestFile("Tests/a.ts")).toBe(false);
    expect(isTestFile("Tests/a.ts", ["tests/**"])).toBe(false);
  });
});

describe("backslash paths in lockedTests and approvedChanges", () => {
  it("a backslash locked test matches a slash change", () => {
    expect(
      detectTamper({ lockedTests: ["tests\\a.ts"], coderChangedFiles: ["tests/a.ts"] }),
    ).toEqual({ tampered: ["tests/a.ts"], ok: false });
  });

  it("a backslash approval matches a slash change", () => {
    expect(
      detectTamper({
        lockedTests: ["tests/a.ts"],
        coderChangedFiles: ["tests/a.ts"],
        approvedChanges: ["tests\\a.ts"],
      }),
    ).toEqual({ tampered: [], ok: true });
  });
});

describe("literal . and [ in custom patterns", () => {
  it("a . in a pattern matches only a literal dot", () => {
    expect(isTestFile("spec.d/a.ts", ["spec.d/**"])).toBe(true);
    expect(isTestFile("specXd/a.ts", ["spec.d/**"])).toBe(false);
  });

  it("a [ in a pattern is literal, not a character class", () => {
    expect(isTestFile("fixtures[1]/a.ts", ["fixtures[1]/**"])).toBe(true);
    expect(isTestFile("fixtures1/a.ts", ["fixtures[1]/**"])).toBe(false);
  });
});
