#!/usr/bin/env node
// T05-02: build the UI with the perf harness (VITE_PERF=1) and serve it, then print the
// harness URLs. Open them in a browser or webview; results show on the page and export as JSON.
// No browser automation is installed in this repo, so there is no headless sweep here.
// Usage: node scripts/perf/streaming.mjs [--port 4173] [--out <dir>] [--no-build]
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({
  options: { port: { type: "string", default: "4173" }, out: { type: "string", default: path.join(tmpdir(), "assentor-perf-ui") }, "no-build": { type: "boolean", default: false } },
});
const out = path.resolve(values.out);
// --emptyOutDir wipes the folder, so only a new or empty folder, or one inside the repo's own build dirs, is accepted.
const inRepoBuild = out.startsWith(path.join(root, "packages/ui/dist") + path.sep) || out === path.join(root, "packages/ui/dist") || out.startsWith(path.join(root, "dist") + path.sep);
if (existsSync(out) && !inRepoBuild && !(statSync(out).isDirectory() && readdirSync(out).length === 0) && !existsSync(path.join(out, ".assentor-perf"))) {
  console.error(`Refusing --out ${out}: it exists and is not empty. Use a new or empty folder.`);
  process.exit(1);
}

if (!values["no-build"]) {
  const vitePackage = fileURLToPath(import.meta.resolve("vite/package.json"));
  const vite = path.join(path.dirname(vitePackage), "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--config", path.join(root, "packages/ui/vite.config.ts"), "--outDir", out, "--emptyOutDir"], {
    cwd: root, stdio: "inherit", env: { ...process.env, VITE_PERF: "1" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  writeFileSync(path.join(out, ".assentor-perf"), "built by scripts/perf/streaming.mjs; safe to rebuild\n");
}
if (!existsSync(path.join(out, "index.html"))) {
  console.error(`No build in ${out}; run without --no-build.`);
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  let file = path.join(out, rel === "/" ? "index.html" : rel);
  // Not startsWith(out): a sibling like <out>-x would pass. Anything that resolves outside <out> gets the app shell.
  const inside = path.relative(out, file);
  if (inside.startsWith("..") || path.isAbsolute(inside) || !existsSync(file) || !statSync(file).isFile()) file = path.join(out, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(Number(values.port), "127.0.0.1", () => {
  const base = `http://127.0.0.1:${values.port}/#/dev/fixtures?perf=1&autorun=1&duration=10`;
  console.log(`Serving ${out}\n\nOne case (6 seats, 50 events/s each):\n  ${base}&seats=6&rate=50\n`);
  console.log(`Rate sweep:\n  ${base}&seats=6&rate=25,50,100,250,500\n`);
  console.log(`Coalescer sweep:\n  ${base}&seats=6&rate=100,250&coalesce=raf,50,100,250\n`);
  console.log(`Seat-count sweep:\n  ${base}&seats=6,12,24,48,96&rate=50\n\nCtrl+C to stop.`);
});
