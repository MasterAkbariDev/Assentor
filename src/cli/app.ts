import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { startServe, type ServeHandle, type ServeOptions } from "../serve/index.js";

/** The `assentor app` launcher: `serve` on a free port, plus opening the browser. */

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface AppOptions {
  projectPath: string;
  /** Default 0 picks a free port, so `app` never clashes with a running `serve`. */
  port?: number;
  /** Set false for `--no-open`: print the URL and never spawn a browser. */
  open?: boolean;
}

export interface AppDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  log?: (line: string) => void;
  startServe?: (options: ServeOptions) => Promise<ServeHandle>;
}

/** Only the loopback origin `startServe` produces may reach a browser command. */
const OPENABLE_URL = /^http:\/\/127\.0\.0\.1:\d+\/(#token=[0-9a-f]+)?$/;

/** The command that opens `url` in the default browser on `platform`. No shell is involved. */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): BrowserOpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort: opens `url` and returns without waiting for the browser.
 * Refuses anything that is not a loopback serve URL. Never throws; if the
 * opener is missing or fails, the caller's printed URL is the fallback.
 */
export function openBrowser(url: string, deps: AppDeps = {}): void {
  if (!OPENABLE_URL.test(url)) {
    return;
  }
  const { command, args } = browserOpenCommand(deps.platform ?? process.platform, url);
  const spawnFn: SpawnFn = deps.spawn ?? nodeSpawn;
  try {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      // The URL is already printed; a missing opener must not crash the launcher.
    });
    child.unref();
  } catch {
    // Same fallback as above: the printed URL is enough.
  }
}

/** Starts the server, prints how to reach it, and opens the browser unless disabled. */
export async function launchApp(options: AppOptions, deps: AppDeps = {}): Promise<ServeHandle> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const start = deps.startServe ?? startServe;
  const handle = await start({
    projectPath: options.projectPath,
    port: options.port ?? 0,
  });
  // The token is printed only in the fragment, so it never reaches a query string or logs of requests.
  log(`Assentor is serving ${options.projectPath}`);
  log(`Open: ${handle.url}`);
  log("Read-only. Press Ctrl+C to stop.");
  if (options.open !== false) {
    openBrowser(handle.url, deps);
  }
  return handle;
}

/** `assentor app`: runs until Ctrl+C or SIGTERM, then stops the server gracefully. */
export async function runApp(options: AppOptions, deps: AppDeps = {}): Promise<void> {
  const handle = await launchApp(options, deps);
  const stop = () => {
    handle.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await handle.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
