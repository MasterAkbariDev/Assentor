import type { WriteStream } from "node:tty";

/**
 * Ink uses log-update (erase previous lines + redraw) when output fits the
 * terminal. That fails in some integrated terminals (e.g. Cursor's panel),
 * leaving ghost header lines in scrollback on every keypress.
 *
 * Force Ink's overflow path: full terminal clear before each frame.
 */
export function createInkStdout(stream: WriteStream = process.stdout): WriteStream {
  if (!stream.isTTY) {
    return stream;
  }

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === "rows") {
        return 1;
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  }) as WriteStream;
}
