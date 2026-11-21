import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
if (process.argv[2] === "--prepare") {
  const dist = path.resolve(directory, "../../packages/ui/dist");
  const entry = path.join(dist, "index.html");
  const html = await readFile(entry, "utf8");
  if (!html.includes("<head>") || html.includes("run-native-cases.js")) throw new Error("Expected a freshly built performance UI.");
  await copyFile(path.join(directory, "run-native-cases.js"), path.join(dist, "run-native-cases.js"));
  await writeFile(entry, html.replace("<head>", '<head><script src="./run-native-cases.js"></script>'));
} else {
  const input = process.argv[2];
  if (!input) throw new Error("Pass the native desktop executable.");
  const binary = path.resolve(process.platform === "win32" && !input.endsWith(".exe") ? `${input}.exe` : input);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "assentor-webview-fixture-"));
  const result = path.join(scratch, "benchmark.json");
  const marker = path.join(scratch, "benchmark.sampling");
  const baseline = process.platform === "win32" ? [] : processes();
  const child = spawn(binary, ["--webview-fixture", result], { stdio: "inherit", windowsHide: true });
  const exit = once(child, "exit");
  const sample = baseline.length ? sampleUsage(child, marker, baseline).catch(() => null) : Promise.resolve(null);
  const timer = setTimeout(() => child.kill(), 420_000);
  try {
    const [code] = await exit;
    if (code !== 0) throw new Error(`The native WebView fixture exited with code ${code}.`);
    const sweeps = JSON.parse(await readFile(result, "utf8"));
    if (sweeps.error) throw new Error(sweeps.error);
    const count = sweeps.flatMap((sweep) => sweep.results).length;
    if (count !== 64 || sweeps.some((sweep) => sweep.results.some((entry) => !entry.complete))) {
      throw new Error("The native WebView did not deliver every event in the benchmark runs.");
    }
    console.log(`Native process sample: ${JSON.stringify(await sample)}`);
    console.log(JSON.stringify(sweeps.map(({ name, userAgent, summary }) => ({ name, userAgent, summary }))));
    console.log("PASS: all 63 native WebView runs delivered every event and the packaged engine responded over native IPC.");
  } finally {
    clearTimeout(timer);
    for (const file of [result, marker]) {
      try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await rmdir(scratch);
  }
}

function processes() {
  const query = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8" });
  if (query.status !== 0) throw new Error("Could not sample native WebView processes.");
  return query.stdout.split("\n").flatMap((line) => {
    const [, pid, parent, rss, time, name] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line) ?? [];
    if (!pid) return [];
    const cpu = time.split(/[-:]/).map(Number).reduceRight((acc, value, index, units) => {
      return acc + value * ([1, 60, 3600, 86400][units.length - index - 1] ?? 0);
    }, 0);
    return [{ pid: Number(pid), parent: Number(parent), rss: Number(rss), cpu, name }];
  });
}

async function sampleUsage(owner, marker, baseline) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (owner.exitCode !== null || owner.signalCode !== null) return null;
    try { await readFile(marker); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (attempt === 59) return null;
    await delay(250);
  }
  const before = processes();
  const ids = new Set([owner.pid]);
  let count;
  do {
    count = ids.size;
    for (const process of before) if (ids.has(process.parent)) ids.add(process.pid);
  } while (count !== ids.size);
  const old = new Set(baseline.map(({ pid }) => pid));
  // WKWebView starts XPC services outside the app's process tree.
  if (process.platform === "darwin") {
    for (const service of before) {
      if (!old.has(service.pid) && /com\.apple\.WebKit\.(?:WebContent|GPU|Networking)/i.test(service.name)) ids.add(service.pid);
    }
  }
  const start = performance.now();
  await delay(4000);
  const elapsedMs = performance.now() - start;
  const first = new Map(before.map((entry) => [entry.pid, entry]));
  const samples = processes().filter(({ pid, name }) => ids.has(pid) && first.get(pid)?.name === name);
  return {
    elapsedMs,
    processes: samples.length,
    cpuSeconds: samples.reduce((sum, entry) => sum + Math.max(0, entry.cpu - first.get(entry.pid).cpu), 0),
    residentKiB: samples.reduce((sum, entry) => sum + entry.rss, 0),
  };
}
