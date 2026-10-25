import { describe, expect, it } from "vitest";
import {
  findExecutorHandoff,
  parseArchitectureSummary,
  parseExecutorExplanation,
} from "../../src/review/pack-builder.js";

const handoff = {
  whatChanged: "Added average()",
  why: "Goal asked for it",
  assumptions: ["inputs are finite"],
  unchanged: "Public API of math.ts",
  risks: ["empty arrays"],
  limitations: [],
  architectureSummary: "math utilities stay in src/math.ts",
};

describe("executor handoff parsing", () => {
  it("reads the last fenced json handoff block in a Markdown reply with code", () => {
    const reply = [
      "## Summary",
      "Implemented `average` in `src/math.ts`:",
      "```ts",
      "export function average(xs: number[]) { return xs.length ? sum(xs) / xs.length : 0; }",
      "```",
      "A config example: ```{ \"strict\": true }``` inline.",
      "```json",
      JSON.stringify({ unrelated: true }),
      "```",
      "## Handoff",
      "```json",
      JSON.stringify(handoff, null, 2),
      "```",
    ].join("\n");

    expect(parseExecutorExplanation(reply)).toMatchObject({
      whatChanged: "Added average()",
      assumptions: ["inputs are finite"],
      risks: ["empty arrays"],
      unchanged: "Public API of math.ts",
    });
    expect(parseArchitectureSummary(reply)).toBe("math utilities stay in src/math.ts");
  });

  it("keeps the old whole-reply JSON behaviour when there is no fenced handoff", () => {
    expect(findExecutorHandoff(`noise ${JSON.stringify(handoff)} trailing`)).toMatchObject({
      whatChanged: "Added average()",
    });
    const plain = parseExecutorExplanation("Changed two files and ran the tests.");
    expect(plain.whatChanged).toBe("Changed two files and ran the tests.");
    expect(plain.assumptions).toEqual([]);
    expect(parseArchitectureSummary("no json here")).toBeUndefined();
  });

  it("is not fooled by a ts block followed by text and an inline fence", () => {
    const reply = [
      "```ts",
      "const a = { x: 1 };",
      "```",
      "Then ```inline``` text with a { brace.",
      "```json",
      JSON.stringify({ whatChanged: "real" }),
      "```",
    ].join("\n");
    expect(findExecutorHandoff(reply)).toEqual({ whatChanged: "real" });
  });

  it("handles CRLF, uppercase and titled json fences, and four-backtick wrappers", () => {
    const body = JSON.stringify({ whatChanged: "crlf" });
    expect(findExecutorHandoff(`text\r\n\`\`\`JSON\r\n${body}\r\n\`\`\`\r\n`)).toEqual({
      whatChanged: "crlf",
    });
    expect(findExecutorHandoff(`\`\`\`json title=handoff\n${body}\n\`\`\``)).toEqual({
      whatChanged: "crlf",
    });
    const wrapped = ["````markdown", "```json", JSON.stringify({ why: "inner" }), "```", "````", "```json", body, "```"].join("\n");
    expect(findExecutorHandoff(wrapped)).toEqual({ whatChanged: "crlf" });
  });

  it("does not treat a line starting with inline code as a fence", () => {
    const reply = ["```code``` is inline here", "```json", JSON.stringify({ whatChanged: "real" }), "```"].join("\n");
    expect(findExecutorHandoff(reply)).toEqual({ whatChanged: "real" });
  });

  it("skips fenced blocks that are not handoff objects or do not parse", () => {
    const reply = "```json\n[1, 2]\n```\n```json\n{ not json\n```\n```\n{\"why\": \"bare fence\"}\n```";
    expect(findExecutorHandoff(reply)).toEqual({ why: "bare fence" });
  });
});

describe("quoteCmdArg", () => {
  it("quotes cmd.exe metacharacters, whitespace, quotes and empty strings", async () => {
    const { quoteCmdArg } = await import("../../src/executors/cli-locator.js");
    expect(quoteCmdArg("C:\\w\\plain.md")).toBe("C:\\w\\plain.md");
    expect(quoteCmdArg("C:\\w\\a&b\\x.md")).toBe('"C:\\w\\a&b\\x.md"');
    expect(quoteCmdArg("a|b")).toBe('"a|b"');
    expect(quoteCmdArg("say \"hi\"")).toBe('"say ""hi"""');
    expect(quoteCmdArg("")).toBe('""');
  });
});
