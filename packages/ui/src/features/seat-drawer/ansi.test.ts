import { describe, expect, it } from "vitest";
import { ansiColor, parseAnsi } from "./ansi.js";

const E = "\u001b";

describe("parseAnsi", () => {
  it("returns one plain span for text without escapes", () => {
    expect(parseAnsi("hello\nworld")).toEqual([{ text: "hello\nworld" }]);
    expect(parseAnsi("")).toEqual([]);
  });

  it("reads 16 colours, bright colours, backgrounds and bold", () => {
    expect(parseAnsi(`${E}[31mred${E}[0m ${E}[1;92mgo${E}[44m!`)).toEqual([
      { text: "red", fg: 1 },
      { text: " " },
      { text: "go", fg: 10, bold: true },
      { text: "!", fg: 10, bold: true, bg: 4 },
    ]);
  });

  it("reads 256-colour foreground and background, and ignores an out-of-range index", () => {
    expect(parseAnsi(`${E}[38;5;196mA${E}[48;5;21mB${E}[38;5;999mC`)).toEqual([
      { text: "A", fg: 196 },
      { text: "BC", fg: 196, bg: 21 },
    ]);
  });

  it("resets with 0, an empty code, 39, 49 and 22", () => {
    expect(parseAnsi(`${E}[1;31;42ma${E}[22mb${E}[39mc${E}[49md${E}[1;31me${E}[mf`)).toEqual([
      { text: "a", fg: 1, bg: 2, bold: true },
      { text: "b", fg: 1, bg: 2 },
      { text: "c", bg: 2 },
      { text: "d" },
      { text: "e", fg: 1, bold: true },
      { text: "f" },
    ]);
  });

  it("drops other escape sequences, skipping truecolor without leaking its numbers", () => {
    const text = `a${E}[2Jb${E}[1;1Hc${E}]0;title\u0007d${E}]8;;http://x${E}\\e${E}[38;2;1;2;3mf${E}[3mg${E}(Bh${E}[31`;
    const out = parseAnsi(text).map((s) => s.text).join("");
    expect(out).toBe("abcdefgh");
    expect(parseAnsi(`${E}[38;2;1;2;3mx`)).toEqual([{ text: "x" }]);
  });

  it("never turns text into markup: it stays literal", () => {
    expect(parseAnsi(`${E}[31m<img src=x onerror=alert(1)>`)).toEqual([{ text: "<img src=x onerror=alert(1)>", fg: 1 }]);
  });
});

describe("ansiColor", () => {
  it("maps base, cube and grey indexes", () => {
    expect(ansiColor(1)).toMatch(/^#/);
    expect(ansiColor(16)).toBe("rgb(0, 0, 0)");
    expect(ansiColor(196)).toBe("rgb(255, 0, 0)");
    expect(ansiColor(232)).toBe("rgb(8, 8, 8)");
  });
});
