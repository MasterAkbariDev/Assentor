import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postject from "postject";

const root = fileURLToPath(new URL("../../", import.meta.url));
const platformTriples = {
  darwin: "apple-darwin",
  linux: "unknown-linux-gnu",
  win32: "pc-windows-msvc",
};
const archTriples = { x64: "x86_64", arm64: "aarch64" };
const platform = platformTriples[process.platform];
const arch = archTriples[process.arch];
if (!platform || !arch || Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("Build with the native Node.js 24 binary on Windows, macOS, or Linux (x64/arm64).");
}

const extension = process.platform === "win32" ? ".exe" : "";
const filename = `assentor-engine-${arch}-${platform}${extension}`;
const binaries = path.join(root, "apps", "desktop", "src-tauri", "binaries");
await mkdir(binaries, { recursive: true });
const staged = await mkdtemp(path.join(binaries, ".build-"));
const executable = path.join(staged, filename);
const bundle = path.join(staged, "engine.cjs");
const blob = path.join(staged, "engine.blob");
const config = path.join(staged, "sea.json");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.signal ?? result.status}).`);
  }
}

try {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/desktop/engine-stdio.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    banner: { js: 'const executableUrl = require("node:url").pathToFileURL(__filename).href;' },
    define: {
      "import.meta.url": "executableUrl",
      ASSENTOR_ENGINE_VERSION: JSON.stringify(version),
    },
  });
  await writeFile(config, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }));
  run(process.execPath, ["--experimental-sea-config", config]);
  await copyFile(process.execPath, executable);

  const macOS = process.platform === "darwin";
  if (macOS) run("codesign", ["--remove-signature", executable]);
  await postject.inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(macOS ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (macOS) run("codesign", ["--force", "--sign", "-", executable]);
  if (process.platform !== "win32") await chmod(executable, 0o755);

  const request = { jsonrpc: "2.0", id: 1, method: "engine.hello", params: {} };
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS"));
  const start = performance.now();
  const smoke = spawnSync(executable, [os.tmpdir()], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) throw new Error(smoke.stderr || `Engine exited with status ${smoke.status}.`);
  const response = JSON.parse(smoke.stdout);
  if (response.jsonrpc !== "2.0" || response.id !== request.id ||
      response.result?.engineVersion !== version ||
      !response.result.capabilities?.includes("engine.hello")) {
    throw new Error("The packaged engine did not complete its JSON-RPC handshake.");
  }
  const elapsedMs = Math.round(performance.now() - start);
  const output = path.join(binaries, filename);
  await rename(executable, output);
  console.log(`Engine ${version} (protocol ${response.result.protocolVersion}) responded in ${elapsedMs} ms.`);
  console.log(output);
} finally {
  await rm(staged, { recursive: true, force: true });
}
