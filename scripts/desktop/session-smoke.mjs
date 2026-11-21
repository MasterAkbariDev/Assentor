import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
const osTriple = { win32: "pc-windows-msvc.exe", linux: "unknown-linux-gnu", darwin: "apple-darwin" }[process.platform];
if (!arch || !osTriple) throw new Error("Unsupported desktop fixture target.");
const engine = path.join(root, "apps", "desktop", "src-tauri", "binaries", `assentor-engine-${arch}-${osTriple}`);
const project = await mkdtemp(path.join(os.tmpdir(), "assentor-desktop-session-"));
const config = path.join(project, ".assentor");
const marker = path.join(project, "provider-was-called");
const provider = path.join(project, "codex-provider.cjs");
const shim = path.join(project, process.platform === "win32" ? "codex.cmd" : "codex");
await writeFile(provider, [
  'if (process.argv.includes("--version")) { console.log("codex-cli 0.171.0"); process.exit(0); }',
  'if (!process.argv.includes("exec")) process.exit(2);',
  'let prompt = ""; process.stdin.setEncoding("utf8").on("data", (chunk) => prompt += chunk);',
  'process.stdin.once("end", () => {',
  '  if (prompt.includes("Hold the desktop fixture open")) {',
  '    const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });',
  '    child.once("spawn", () => require("node:fs").writeFileSync(process.env.ASSENTOR_FIXTURE_MARKER, JSON.stringify([process.pid, child.pid])));',
  '    return;',
  '  }',
  '  if (!prompt.includes("Exercise the desktop session fixture")) process.exit(3);',
  '  require("node:fs").writeFileSync(process.env.ASSENTOR_FIXTURE_MARKER, "exec");',
  '  console.log("The fixture provider completed successfully.");',
  '});',
].join("\n"));
await writeFile(shim, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "%~dp0codex-provider.cjs" %*\r\n`
  : '#!/bin/sh\nexec "$ASSENTOR_FIXTURE_NODE" "$ASSENTOR_FIXTURE_PROVIDER" "$@"\n', { mode: 0o755 });
await mkdir(config);
await writeFile(path.join(config, "config.yaml"), JSON.stringify({
  executor: { provider: "codex" },
  reviewers: [{ provider: "mock" }],
  run: { autonomy: "supervised" },
}));
const git = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8", windowsHide: true });
if (git.status !== 0) throw new Error(git.stderr || "Could not initialize the fixture Git repository.");
const env = {
  ...process.env,
  ASSENTOR_USER_DIR: path.join(project, "user", ".assentor"),
  ASSENTOR_CODEX_BINARY: shim,
  ASSENTOR_FIXTURE_MARKER: marker,
  ASSENTOR_FIXTURE_NODE: process.execPath,
  ASSENTOR_FIXTURE_PROVIDER: provider,
};
delete env.ASSENTOR_DESKTOP_HOST;
delete env.NODE_OPTIONS;
const hostArg = process.argv[2];
const host = hostArg ? path.resolve(process.platform === "win32" && !hostArg.endsWith(".exe") ? `${hostArg}.exe` : hostArg) : undefined;
const child = spawn(host ?? engine, host ? ["--fixture-engine", project, root] : [project, root], {
  cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
});
const ended = once(child, "exit");
const lines = createInterface({ input: child.stdout });
const calls = new Map();
const events = [];
let next = 1;
let forceQuit = false;
lines.on("line", (line) => {
  const reply = JSON.parse(line);
  if (reply.method === "events.event") events.push(reply.params.event);
  const resolve = calls.get(reply.id);
  if (resolve) { calls.delete(reply.id); resolve(reply); }
});

function call(method, params = {}) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Timed out waiting for ${method}`)); }, 10_000);
    calls.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
      else resolve(reply.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function approve(sessionId) {
  const { pendingApprovals } = await call("session.get", { sessionId });
  for (const id of pendingApprovals) await call("session.approve", { sessionId, id, decision: "approve" });
}

function running(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "win32") return true;
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout && !result.stderr) return false;
  if (result.status !== 0) throw new Error("Could not inspect the fixture process.");
  return !result.stdout.trimStart().startsWith("Z");
}

try {
  const { capabilities } = await call("engine.hello");
  if (!capabilities.includes("session.start")) throw new Error("Native session control is unavailable.");
  const { prompts } = await call("prompt.list");
  if (!prompts.length) throw new Error("The packaged engine did not load built-in prompts.");
  const { sessionId } = await call("session.create", { mode: "solo", goal: "Exercise the desktop session fixture", autonomy: "supervised" });
  await call("session.start", { sessionId });
  const { subscriptionId } = await call("events.subscribe", { sessionId, fromSeq: 0 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.type === "session.completed" || event.type === "session.failed")) break;
    await approve(sessionId);
    await delay(100);
  }
  if (!events.some((event) => event.type === "session.completed")) {
    throw new Error(`The fixture did not complete: ${events.map((event) => event.type).join(", ")}`);
  }
  if (!events.some((event) => event.type.startsWith("seat.") || event.stageId)) {
    throw new Error(`No worker stages were streamed: ${events.map((event) => event.type).join(", ")}`);
  }
  if (await readFile(marker, "utf8") !== "exec") throw new Error("The stand-in Codex executable was not called.");
  await call("events.unsubscribe", { subscriptionId });
  console.log(`PASS: ${host ? "native host" : "packaged engine"} ran the stand-in Codex executable and streamed ${events.length} events.`);
  if (host) {
    child.stdin.write("--assentor-reset-desktop-rpc--\n");
    const hold = await call("session.create", { mode: "solo", goal: "Hold the desktop fixture open", autonomy: "supervised" });
    await call("session.start", { sessionId: hold.sessionId });
    let pids;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await approve(hold.sessionId);
      const data = await readFile(marker, "utf8");
      if (data.startsWith("[")) { pids = JSON.parse(data); break; }
      await delay(100);
    }
    if (pids?.length !== 2 || !pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && running(pid))) {
      throw new Error("The fixture provider and its child were not both running.");
    }
    if (!child.kill("SIGKILL")) throw new Error("Could not force-quit the native fixture host.");
    forceQuit = true;
    for (let attempt = 0; attempt < 70 && pids.some(running); attempt += 1) await delay(100);
    if (pids.some(running)) throw new Error("A fixture subprocess survived force-quit.");
    console.log("PASS: force-quitting the native host stopped the stand-in provider and its child.");
  }
} finally {
  child.stdin.end();
  const watchdog = setTimeout(() => child.kill(), 8_000);
  const [exitCode] = await ended;
  clearTimeout(watchdog);
  lines.close();
  await rm(project, { recursive: true, force: true });
  if (exitCode !== 0 && !forceQuit) throw new Error(`Desktop protocol fixture exited with code ${exitCode}`);
}
