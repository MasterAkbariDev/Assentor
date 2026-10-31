/** Reset raw mode and cursor visibility before spawning a replacement CLI/TUI. */
export function resetTerminalForRelaunch(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h\x1b[0m");
  }
}
