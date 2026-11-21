import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [ready, codex] = process.argv.slice(2);
process.stdin.once("data", (chunk) => {
  if (chunk.toString() !== "1") throw new Error("The fixture was not assigned to its process guard.");
  const child = codex
    ? spawn(codex, ["app-server"], { windowsHide: true, stdio: ["pipe", "ignore", "inherit"] })
    : spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, stdio: "ignore" });
  // Bound the fixture lifetime even if the platform mechanism fails.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.once("spawn", () => writeFileSync(ready, JSON.stringify({ launcher: process.pid, worker: child.pid })));
  child.once("error", (error) => { throw error; });
  child.once("exit", (code) => {
    clearTimeout(deadline);
    process.exitCode = code ?? 1;
  });
});
