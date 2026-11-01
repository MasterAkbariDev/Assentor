import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diffModel.js";

describe("parseUnifiedDiff", () => {
  it("splits files and hunks and classifies lines", () => {
    const text = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -9 +9 @@",
      "+tail",
      "diff --git a/b b/b",
      "Binary files a/b and b/b differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b"]);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add"]);
    expect(files[1]!.hunks).toHaveLength(0);
    expect(files[1]!.meta.at(-1)).toContain("Binary");
  });
});
