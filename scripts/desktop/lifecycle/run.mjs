import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const codex = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const target = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(root, "target"));
const built = spawnSync("cargo", [
  "build", "--locked", "--manifest-path", path.join(root, "Cargo.toml"), "--target-dir", target,
], { stdio: "inherit", windowsHide: true });
if (built.error) throw built.error;
if (built.status !== 0) throw new Error("Could not build the native lifecycle probe.");

const scratch = await mkdtemp(path.join(os.tmpdir(), "assentor-lifecycle-"));
const ready = path.join(scratch, "fixture-pids.json");
const windows = process.platform === "win32";
const probe = path.join(target, "debug", `assentor-lifecycle-probe${windows ? ".exe" : ""}`);
const owner = spawn(probe, [
  process.execPath, path.join(root, "launcher.mjs"), ready, ...(codex ? [codex] : []),
], { cwd: scratch, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
let launchError;
owner.on("error", (error) => { launchError = error; });

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function isRunning(pid) {
  if (!exists(pid)) return false;
  if (windows) return true;
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (status.error) throw status.error;
  const state = status.stdout.trim();
  if (status.status !== 0 || !state) {
    if (!exists(pid)) return false;
    throw new Error(`Could not inspect fixture process ${pid}: ${status.stderr.trim() || "no process state"}`);
  }
  return !state.startsWith("Z");
}

let processes;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (launchError) throw launchError;
    if (owner.exitCode !== null || owner.signalCode !== null) throw new Error("The owner exited before the probe was ready.");
    try {
      const ids = JSON.parse(await readFile(ready, "utf8"));
      if (Number.isSafeInteger(ids.launcher) && ids.launcher > 0 &&
          Number.isSafeInteger(ids.worker) && ids.worker > 0) {
        processes = [ids.launcher, ids.worker];
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  if (!processes) throw new Error("The fixture did not start.");
  await delay(300);
  if (!processes.every(isRunning)) throw new Error("The fixture team did not stay alive before force-quit.");
  if (!owner.kill("SIGKILL")) throw new Error("Could not force-quit the owner.");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!processes.some(isRunning)) {
      console.log(`PASS: force-quit stopped the launcher and ${codex ? "Codex app-server" : "fixture"} subprocess.`);
      break;
    }
    if (attempt === 59) throw new Error("The process tree survived force-quit.");
    await delay(100);
  }
} finally {
  if (!owner.killed && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
  try { await unlink(ready); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rmdir(scratch); }
  catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
}
