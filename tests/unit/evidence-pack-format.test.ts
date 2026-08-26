import { describe, expect, it } from "vitest";
import { formatChangedFilesList } from "../../src/review/evidence-pack.js";

describe("formatChangedFilesList", () => {
  it("lists all paths when under the cap", () => {
    expect(formatChangedFilesList(["a.ts", "b.ts"])).toBe("a.ts, b.ts");
  });

  it("truncates long changed-file lists with a hint to request more", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    const formatted = formatChangedFilesList(files, 10);
    expect(formatted).toContain("src/file-0.ts");
    expect(formatted).toContain("50 more");
    expect(formatted).toContain("evidenceRequests");
  });
});
