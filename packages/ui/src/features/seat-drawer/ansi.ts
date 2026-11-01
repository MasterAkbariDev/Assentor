/**
 * A small SGR parser for the Output tab: 16 and 256 colours, bold and reset. Every other
 * escape sequence (cursor moves, titles, truecolor, italic, ...) is dropped. It yields
 * plain-text spans; nothing here produces HTML, so the text can never be markup.
 */

export interface AnsiSpan {
  text: string;
  /** Palette index 0-255. */
  fg?: number;
  bg?: number;
  bold?: boolean;
}

// CSI (ESC [ params intermediates final), OSC (ESC ] ... BEL or ESC \), or ESC plus one char (or an intermediate and a final, like ESC ( B).
const SEQUENCE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\[[0-?]*[ -/]*$|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[ -/][0-~]|[@-Z\\-_])/g;

interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
}

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  const push = (raw: string) => {
    const text = raw.replace(/\u001b/g, ""); // a lone ESC (cut-off sequence) is not text
    if (text === "") {
      return;
    }
    const last = spans[spans.length - 1];
    if (last && last.fg === style.fg && last.bg === style.bg && last.bold === style.bold) {
      last.text += text;
    } else {
      spans.push({ text, ...style });
    }
  };

  let index = 0;
  for (const match of input.matchAll(SEQUENCE)) {
    push(input.slice(index, match.index));
    index = match.index + match[0].length;
    if (match[2] === "m") {
      style = applySgr(style, match[1] ?? "");
    }
  }
  push(input.slice(index));
  return spans;
}

function applySgr(prev: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  let style = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 22) delete style.bold;
    else if (code >= 30 && code <= 37) style.fg = code - 30;
    else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    else if (code >= 40 && code <= 47) style.bg = code - 40;
    else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
    else if (code === 39) delete style.fg;
    else if (code === 49) delete style.bg;
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2];
        if (n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255) {
          if (code === 38) style.fg = n;
          else style.bg = n;
        }
        i += 2;
      } else if (mode === 2) {
        i += 4; // truecolor is skipped, not approximated
      } else {
        i += 1;
      }
    }
  }
  return style;
}

const BASE16 = [
  "#586069", "#cf222e", "#1a7f37", "#9a6700", "#0969da", "#8250df", "#1b7c83", "#8c959f",
  "#6e7781", "#ff6a69", "#2da44e", "#bf8700", "#4493f8", "#a371f7", "#3192aa", "#b1bac4",
];

/** CSS colour for a palette index: the 16 base colours, the 6x6x6 cube, then 24 greys. */
export function ansiColor(n: number): string {
  if (n < 16) return BASE16[n] as string;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(c / 36))}, ${level(Math.floor(c / 6) % 6)}, ${level(c % 6)})`;
}
