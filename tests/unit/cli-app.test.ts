import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { browserOpenCommand, launchApp, openBrowser, type SpawnFn } from "../../src/cli/app.js";
import type { ServeHandle } from "../../src/serve/index.js";

const dirs: string[] = [];
const handles: ServeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const URL_WITH_TOKEN = "http://127.0.0.1:4319/#token=abc123";

/** A spawn stand-in that records calls and returns a child that can emit events and be unref'd. */
function fakeSpawn() {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const children: (EventEmitter & { unref: ReturnType<typeof vi.fn> })[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, children };
}

describe("browserOpenCommand", () => {
  it("uses open on macOS", () => {
    expect(browserOpenCommand("darwin", URL_WITH_TOKEN)).toEqual({
      command: "open",
      args: [URL_WITH_TOKEN],
    });
  });

  it("uses cmd start with an empty title on Windows", () => {
    expect(browserOpenCommand("win32", URL_WITH_TOKEN)).toEqual({
      command: "cmd",
      args: ["/c", "start", "", URL_WITH_TOKEN],
    });
  });

  it("uses xdg-open on Linux and other platforms", () => {
    expect(browserOpenCommand("linux", URL_WITH_TOKEN)).toEqual({
      command: "xdg-open",
      args: [URL_WITH_TOKEN],
    });
    expect(browserOpenCommand("freebsd", URL_WITH_TOKEN)).toEqual({
      command: "xdg-open",
      args: [URL_WITH_TOKEN],
    });
  });
});

describe("openBrowser", () => {
  it("spawns the platform opener detached, ignored, without a shell, then unrefs", () => {
    const { spawn, calls, children } = fakeSpawn();
    openBrowser(URL_WITH_TOKEN, { platform: "darwin", spawn });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "open",
      args: [URL_WITH_TOKEN],
      options: { detached: true, stdio: "ignore", windowsHide: true },
    });
    expect(calls[0]?.options.shell).toBeUndefined();
    expect(children[0]?.unref).toHaveBeenCalledTimes(1);
  });

  it("refuses URLs that are not a loopback serve URL, without spawning", () => {
    const { spawn, calls } = fakeSpawn();
    const unsafe = [
      "http://evil.example/#token=abc123",
      "http://0.0.0.0:4319/#token=abc123",
      "https://127.0.0.1:4319/#token=abc123",
      "http://127.0.0.1:4319/?token=abc123",
      "http://127.0.0.1:4319/#token=NOT-HEX",
      "http://127.0.0.1:4319/#token=abc123 && rm -rf ~",
      "http://127.0.0.1:4319/;open -a Calculator",
    ];
    for (const url of unsafe) {
      openBrowser(url, { platform: "darwin", spawn });
    }
    expect(calls).toHaveLength(0);
  });

  it("does not throw when spawn throws", () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    expect(() => openBrowser(URL_WITH_TOKEN, { platform: "linux", spawn })).not.toThrow();
  });

  it("does not throw when the child emits an error event", () => {
    const { spawn, children } = fakeSpawn();
    openBrowser(URL_WITH_TOKEN, { platform: "linux", spawn });
    expect(() => children[0]?.emit("error", new Error("spawn xdg-open ENOENT"))).not.toThrow();
  });
});

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-app-project-"));
  dirs.push(dir);
  return dir;
}

describe("launchApp", () => {
  it("starts a real server on a free port and prints the URL with the token only in the fragment", async () => {
    const projectPath = await tempProject();
    const lines: string[] = [];
    const { spawn, calls } = fakeSpawn();
    const handle = await launchApp(
      { projectPath, open: true },
      { platform: "linux", spawn, log: (line) => lines.push(line) },
    );
    handles.push(handle);

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+$/);
    expect(new URL(handle.url).search).toBe("");
    expect(lines).toContain(`Assentor is serving ${projectPath}`);
    expect(lines).toContain(`Open: ${handle.url}`);
    expect(lines.join("\n")).not.toMatch(/\?token=/);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("xdg-open");
    expect(calls[0]?.args).toEqual([handle.url]);
  });

  it("with --no-open never spawns a browser", async () => {
    const projectPath = await tempProject();
    const { spawn, calls } = fakeSpawn();
    const handle = await launchApp(
      { projectPath, open: false },
      { platform: "darwin", spawn, log: () => {} },
    );
    handles.push(handle);

    expect(handle.url).toContain("#token=");
    expect(calls).toHaveLength(0);
  });
});
