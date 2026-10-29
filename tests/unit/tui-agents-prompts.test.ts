import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssentorConfig } from "../../src/config/schema.js";
import { PromptLibrary, type PromptLibraryLoadOptions } from "../../src/prompts/index.js";
import { createAssentorServices, type AssentorServices } from "../../src/services/app.js";
import { App, startTui, type TuiHandoff } from "../../src/tui/app.js";

type LoadPrompts = (options: PromptLibraryLoadOptions) => Promise<PromptLibrary>;
import { createInitialUiState, mapKeyToAction } from "../../src/tui/keymap.js";
import {
  AgentsScreen,
  orderedPrompts,
  validateSummary,
  warningLines,
} from "../../src/tui/screens/agents.js";
import { HelpScreen } from "../../src/tui/screens/help.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\([a-zA-Z]/g, "");
}

/** Prompt file text. */
function promptText(id: string, options: { role?: string; title?: string; body?: string } = {}): string {
  return [
    "---",
    `id: ${id}`,
    `role: ${options.role ?? "builder"}`,
    `title: ${options.title ?? id}`,
    "version: 1",
    "---",
    options.body ?? `Body of ${id}.`,
    "",
  ].join("\n");
}

/** Last non-blank chunk Ink wrote (debug mode writes one full frame per render). */
function lastFrame(chunks: string[]): string[] {
  const frames = chunks.filter((chunk) => stripAnsi(chunk).trim().length > 0);
  return stripAnsi(frames[frames.length - 1] ?? "").split("\n");
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A stdin that Ink treats as a terminal: it can receive keys and accepts raw mode. */
function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void; ref: () => void; unref: () => void } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (on: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

/** Render an element at a fixed width and return the lines of the last frame. */
async function renderToLines(element: React.ReactElement, columns: number): Promise<string[]> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = columns;
    stdout.rows = 60;
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const instance = render(element, {
      stdout: stdout as never,
      stdin: fakeTty() as never,
      patchConsole: false,
      debug: true,
    });
    setTimeout(() => {
      try {
        instance.unmount();
      } catch {
        // already unmounted
      }
      resolve(lastFrame(chunks));
    }, 80);
  });
}

// Keys as Ink delivers them.
const ENTER = "\r";

describe("tui agents prompts", () => {
  let root: string;
  let userDir: string;
  let builtinDir: string;
  let projectDir: string;
  let userRoot: string;
  const savedSkip = process.env.ASSENTOR_SKIP_UPDATE_CHECK;

  beforeAll(() => {
    process.env.ASSENTOR_SKIP_UPDATE_CHECK = "1";
  });

  afterAll(() => {
    if (savedSkip === undefined) {
      delete process.env.ASSENTOR_SKIP_UPDATE_CHECK;
    } else {
      process.env.ASSENTOR_SKIP_UPDATE_CHECK = savedSkip;
    }
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-agents-"));
    userDir = path.join(root, "user");
    builtinDir = path.join(root, "builtin");
    projectDir = path.join(root, "project");
    userRoot = path.join(root, "user-root");
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(builtinDir, "alpha.md"), promptText("alpha", { title: "Alpha builder", body: "L01\nL02\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\nL11\nL12" }));
    await fs.writeFile(path.join(builtinDir, "gamma.md"), promptText("gamma", { role: "reviewer", title: "Gamma reviewer" }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe("the Agents screen", () => {
    async function loadedPrompts() {
      const library = await PromptLibrary.load({ projectPath: projectDir, userDir, builtinDir });
      return { library, prompts: orderedPrompts(library.list()) };
    }

    it("groups prompts by role, with a layer badge and an override note", async () => {
      await fs.writeFile(path.join(userDir, "alpha.md"), promptText("alpha", { title: "Alpha user" }));
      await fs.writeFile(path.join(userDir, "beta.md"), promptText("beta"));
      const { prompts } = await loadedPrompts();

      const lines = await renderToLines(
        React.createElement(AgentsScreen, {
          agents: [],
          selected: 0,
          focused: true,
          prompts,
          errors: [],
          loading: false,
          loadError: null,
          preview: null,
          forkPending: false,
          notice: [],
        }),
        80,
      );
      const text = lines.join("\n");

      expect(text).toContain("Specialty agents: none configured");
      expect(text.indexOf("Builder prompts")).toBeLessThan(text.indexOf("Reviewer prompts"));
      expect(text).toContain("alpha");
      expect(text).toContain("Alpha user");
      expect(text).toContain("[user]");
      expect(text).toContain("[builtin]");
      expect(text).toContain("overrides builtin");
      expect(text).toContain("Gamma reviewer");
    });

    it("shows the warning panel with the count and the first three errors", async () => {
      for (const name of ["a", "b", "c", "d"]) {
        await fs.writeFile(path.join(userDir, `broken-${name}.md`), "no front matter\n");
      }
      const library = await PromptLibrary.load({ projectPath: projectDir, userDir, builtinDir });
      expect(library.errors).toHaveLength(4);

      const lines = await renderToLines(
        React.createElement(AgentsScreen, {
          agents: [],
          selected: 0,
          focused: true,
          prompts: orderedPrompts(library.list()),
          errors: [...library.errors],
          loading: false,
          loadError: null,
          preview: null,
          forkPending: false,
          notice: [],
        }),
        80,
      );
      const text = lines.join("\n");

      expect(text).toContain("4 prompt file(s) failed to load");
      expect(text).toContain("…and 1 more");
      expect(warningLines(library.errors)).toHaveLength(3);
      expect(warningLines(library.errors)[0]).toMatch(/^user .*broken-a\.md: /);
    });

    it("the preview shows the chosen window of the body", async () => {
      const { prompts } = await loadedPrompts();
      const alpha = prompts.find((prompt) => prompt.id === "alpha")!;
      expect(alpha.body.split("\n")).toHaveLength(12);

      const lines = await renderToLines(
        React.createElement(AgentsScreen, {
          agents: [],
          selected: prompts.indexOf(alpha),
          focused: true,
          prompts,
          errors: [],
          loading: false,
          loadError: null,
          preview: { scroll: 3 },
          forkPending: false,
          notice: [],
        }),
        80,
      );
      const text = lines.join("\n");

      expect(text).toContain("Preview: alpha (lines 4–11 of 12)");
      expect(text).toContain("L04");
      expect(text).toContain("L11");
      expect(text).not.toContain("L01");
    });

    it("the fork choice and the notice are shown", async () => {
      const { prompts } = await loadedPrompts();
      const lines = await renderToLines(
        React.createElement(AgentsScreen, {
          agents: [],
          selected: 0,
          focused: true,
          prompts,
          errors: [],
          loading: false,
          loadError: null,
          preview: null,
          forkPending: true,
          notice: ['Prompt "alpha" already exists at /somewhere/alpha.md'],
        }),
        80,
      );
      const text = lines.join("\n");
      expect(text).toContain("[u] user · [p] project · [Esc] cancel");
      expect(text).toContain("already exists at");
    });

    it("keeps every line within 80 columns, with a long preview and long names", async () => {
      await fs.writeFile(
        path.join(userDir, "long.md"),
        promptText("long-prompt-id-that-goes-on-and-on-for-a-long-way", {
          title: "A very long title that will not fit on one line of an eighty column terminal at all",
          body: "x".repeat(200),
        }),
      );
      const { prompts } = await loadedPrompts();
      const lines = await renderToLines(
        React.createElement(AgentsScreen, {
          agents: [],
          selected: prompts.findIndex((prompt) => prompt.id.startsWith("long")),
          focused: true,
          prompts,
          errors: [{ file: "/a/very/long/path/that/keeps/going/broken.md", layer: "user", message: "missing front-matter, which is a long message to wrap" }],
          loading: false,
          loadError: null,
          preview: { scroll: 0 },
          forkPending: false,
          notice: ["Forked a prompt to the user layer and wrote it to a long path"],
        }),
        80,
      );
      for (const line of lines) {
        expect([...line].length, line).toBeLessThanOrEqual(80);
      }
    });

    it("the help screen documents Enter, f, e and v for the Agents screen", async () => {
      const lines = await renderToLines(React.createElement(HelpScreen), 80);
      const text = lines.join("\n");
      expect(text).toContain("Agents Screen");
      expect(text).toContain("Preview");
      expect(text).toContain("Fork");
      expect(text).toContain("Edit");
      expect(text).toContain("Validate");
      for (const line of lines) {
        expect([...line].length, line).toBeLessThanOrEqual(80);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("keys on the Agents screen", () => {
    const agents = createInitialUiState({ screen: "agents", focus: "main" });

    it("Enter previews a prompt here, and activates elsewhere", () => {
      expect(mapKeyToAction(agents, { input: "", return: true }).type).toBe("agents_preview");
      const workspace = createInitialUiState({ screen: "workspace", focus: "main" });
      expect(mapKeyToAction(workspace, { input: "", return: true }).type).toBe("activate");
    });

    it("f, e and v map to fork, edit and validate on the Agents screen only", () => {
      expect(mapKeyToAction(agents, { input: "f" }).type).toBe("agents_fork");
      expect(mapKeyToAction(agents, { input: "e" }).type).toBe("agents_edit");
      expect(mapKeyToAction(agents, { input: "v" }).type).toBe("agents_validate");
      const tasks = createInitialUiState({ screen: "tasks", focus: "main" });
      expect(mapKeyToAction(tasks, { input: "e" }).type).toBe("noop");
      expect(mapKeyToAction(tasks, { input: "v" }).type).toBe("noop");
    });
  });

  // -------------------------------------------------------------------------
  describe("the App on the Agents screen", () => {
    let services: AssentorServices;
    let mounted: { unmount: () => void } | undefined;

    beforeEach(async () => {
      services = await createAssentorServices(projectDir, { userRoot });
    });

    afterEach(() => {
      mounted?.unmount();
      mounted = undefined;
    });

    /** Mount the real App on the Agents screen with a fake terminal. */
    function mount(extra: { initialPromptId?: string; loadPrompts?: LoadPrompts } = {}) {
      const chunks: string[] = [];
      const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
      stdout.columns = 80;
      stdout.rows = 60;
      stdout.on("data", (chunk) => chunks.push(chunk.toString()));
      const stdin = fakeTty();
      const handoffs: TuiHandoff[] = [];
      const instance = render(
        React.createElement(App, {
          services,
          initialConfig: parseAssentorConfig({}),
          initialUi: { screen: "agents", navIndex: 2 },
          promptDirs: { userDir, builtinDir },
          initialPromptId: extra.initialPromptId,
          loadPrompts: extra.loadPrompts,
          onHandoff: (handoff: TuiHandoff) => handoffs.push(handoff),
        }),
        { stdout: stdout as never, stdin: stdin as never, patchConsole: false, debug: true },
      );
      mounted = instance;
      return {
        handoffs,
        text: () => lastFrame(chunks).join("\n"),
        lines: () => lastFrame(chunks),
        async press(keys: string) {
          stdin.write(keys);
          await new Promise((resolve) => setTimeout(resolve, 80));
        },
        unmount: () => instance.unmount(),
      };
    }

    it("loads the library and lists prompts grouped by role", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");
      expect(app.text()).toContain("Reviewer prompts");
      expect(app.text()).toContain("[builtin]");
    });

    it("Enter opens the body preview, and Enter again closes it", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

      await app.press(ENTER);
      expect(app.text()).toContain("Preview: alpha");
      await app.press(ENTER);
      expect(app.text()).not.toContain("Preview: alpha");
    });

    it("f then u forks the prompt into the user layer; a second fork says it already exists", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

      await app.press("f");
      expect(app.text()).toContain("[u] user");
      await app.press("u");
      await waitFor(() => existsSync(path.join(userDir, "alpha.md")), "the forked file");
      await waitFor(() => app.text().includes('Forked "alpha" to the user layer'), "the fork message");

      await app.press("f");
      await app.press("u");
      await waitFor(() => app.text().includes("already exists at"), "the refusal");
      expect(existsSync(path.join(userDir, "alpha.md"))).toBe(true);
    });

    it("e with only the built-in shows the fork hint and no handoff", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

      await app.press("e");
      await waitFor(() => app.text().includes("Fork it first (f)"), "the fork hint");
      expect(app.handoffs).toEqual([]);
    });

    it("e with a user copy hands off the copy's file for the editor, without spawning one", async () => {
      await fs.writeFile(path.join(userDir, "alpha.md"), promptText("alpha", { title: "Alpha user" }));
      const app = mount();
      await waitFor(() => app.text().includes("Alpha user"), "the user copy");

      await app.press("e");
      await waitFor(() => app.handoffs.length > 0, "the handoff");
      expect(app.handoffs).toEqual([{ kind: "edit-prompt", file: path.join(userDir, "alpha.md") }]);
    });

    it("v shows the valid message with the loaded count", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

      await app.press("v");
      await waitFor(() => app.text().includes("All prompts valid (2 loaded)"), "the validate result");
    });

    it("v shows the warning panel when a prompt file fails to load", async () => {
      await fs.writeFile(path.join(userDir, "broken.md"), "no front matter\n");
      const app = mount();
      await waitFor(() => app.text().includes("failed to load"), "the warning panel");

      await app.press("v");
      await waitFor(() => app.text().includes("1 prompt file(s) failed to load"), "the validate result");
    });

    // POSIX permission bits: a read-only directory is not enforced by chmod on Windows.
    it.skipIf(process.platform === "win32")("a fork the filesystem refuses shows the error, the run continues, and nothing rejects", async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onRejection);
      await fs.chmod(userDir, 0o555);
      try {
        const app = mount();
        await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

        await app.press("f");
        await app.press("u");
        await waitFor(() => app.text().includes("Fork failed"), "the fork error");
        expect(app.text()).toContain("EACCES");

        // The TUI is still alive: validate still works.
        await app.press("v");
        await waitFor(() => app.text().includes("All prompts valid (2 loaded)"), "validate after the error");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
        await fs.chmod(userDir, 0o755);
      }
    });

    it("a library load that rejects shows the error instead of the spinner, and v retries", async () => {
      let calls = 0;
      const loadPrompts: LoadPrompts = (options) => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("unreadable layer /locked"));
        }
        return PromptLibrary.load(options);
      };
      const app = mount({ loadPrompts });

      await waitFor(() => app.text().includes("Could not load prompts: unreadable layer /locked"), "the load error");
      expect(app.text()).not.toContain("Loading prompts…");

      await app.press("v");
      await waitFor(() => app.text().includes("All prompts valid (2 loaded)"), "the retry");
      expect(app.text()).not.toContain("Could not load prompts");
      expect(calls).toBe(2);
    });

    it("the selected prompt stays selected after a fork", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");

      await app.press("j");
      await waitFor(() => app.text().includes("› gamma"), "gamma selected");
      await app.press("f");
      await app.press("u");
      await waitFor(() => app.text().includes('Forked "gamma"'), "the fork message");
      expect(app.text()).toContain("› gamma");
      expect(app.text()).not.toContain("› alpha");
    });

    it("mounting with an initial prompt id selects that prompt", async () => {
      const app = mount({ initialPromptId: "gamma" });
      await waitFor(() => app.text().includes("› gamma"), "gamma selected on mount");
    });

    it("keeps every line of the App within 80 columns", async () => {
      const app = mount();
      await waitFor(() => app.text().includes("Builder prompts"), "the prompt list");
      await app.press(ENTER);
      for (const line of app.lines()) {
        expect([...line].length, line).toBeLessThanOrEqual(80);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("validateSummary", () => {
    it("uses the CLI wording", () => {
      expect(validateSummary(3, 0)).toBe("All prompts valid (3 loaded)");
      expect(validateSummary(3, 2)).toBe("2 prompt file(s) failed to load; see the warning panel");
    });
  });
});

// ---------------------------------------------------------------------------
// startTui: the edit loop, with Ink's render and the editor both injected
// ---------------------------------------------------------------------------

describe("startTui edit loop", () => {
  let root: string;
  let projectDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-loop-"));
    projectDir = path.join(root, "project");
    await fs.mkdir(projectDir, { recursive: true });
    process.env.ASSENTOR_USER_DIR = path.join(root, "user-root", ".assentor");
  });

  afterEach(async () => {
    if (savedUserDir === undefined) {
      delete process.env.ASSENTOR_USER_DIR;
    } else {
      process.env.ASSENTOR_USER_DIR = savedUserDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * A stand-in for Ink's render. Each call records its props and then runs the
   * step for that call; a step can call `onHandoff`, as the App does on exit.
   */
  function fakeRender(steps: Array<(props: Record<string, unknown>) => void>) {
    const renders: Array<Record<string, unknown>> = [];
    const fn = ((element: React.ReactElement) => {
      const props = element.props as Record<string, unknown>;
      renders.push(props);
      steps[renders.length - 1]?.(props);
      return {
        waitUntilExit: async () => {},
        unmount: () => {},
      } as unknown as ReturnType<typeof render>;
    }) as unknown as typeof render;
    return { fn, renders };
  }

  const handOff = (props: Record<string, unknown>, handoff: TuiHandoff) =>
    (props.onHandoff as (next: TuiHandoff) => void)(handoff);

  it("an edit runs the editor on the file and re-renders on the Agents screen with the prompt selected", async () => {
    const file = path.join(root, "user", "alpha.md");
    const runEditor = async (opened: string) => {
      expect(opened).toBe(file);
      return 0;
    };
    const { fn, renders } = fakeRender([
      (props) => handOff(props, { kind: "edit-prompt", file }),
      (props) => handOff(props, { kind: "exit" }),
    ]);

    const result = await startTui(projectDir, { runEditor, render: fn });

    expect(result).toEqual({ kind: "exit" });
    expect(renders).toHaveLength(2);
    expect(renders[1]!.initialUi).toMatchObject({ screen: "agents" });
    expect(renders[1]!.initialPromptId).toBe("alpha");
    expect(renders[1]!.initialNotice).toBeUndefined();
  });

  it("an editor that cannot start re-renders on Agents with an error notice", async () => {
    const file = path.join(root, "user", "alpha.md");
    const { fn, renders } = fakeRender([
      (props) => handOff(props, { kind: "edit-prompt", file }),
      (props) => handOff(props, { kind: "exit" }),
    ]);

    await startTui(projectDir, {
      runEditor: async () => {
        throw new Error("spawn vi ENOENT");
      },
      render: fn,
    });

    expect(renders).toHaveLength(2);
    expect(renders[1]!.initialNotice).toEqual(["Could not start the editor: spawn vi ENOENT"]);
    expect(renders[1]!.initialUi).toMatchObject({ screen: "agents" });
  });

  it("an editor that exits non-zero re-renders on Agents with its exit code in the notice", async () => {
    const file = path.join(root, "user", "alpha.md");
    const { fn, renders } = fakeRender([
      (props) => handOff(props, { kind: "edit-prompt", file }),
      (props) => handOff(props, { kind: "exit" }),
    ]);

    await startTui(projectDir, { runEditor: async () => 3, render: fn });

    expect(renders[1]!.initialNotice).toEqual(["Editor exited with code 3."]);
  });

  it("remounts with the config saved before the edit round trip", async () => {
    const userConfig = path.join(process.env.ASSENTOR_USER_DIR!, "config.yaml");
    const file = path.join(root, "user", "alpha.md");
    const { fn, renders } = fakeRender([
      (props) => {
        expect((props.initialConfig as { run: { mode: string } }).run.mode).toBe("autopilot");
        // The user switched to Supervised and saved while the first App was mounted.
        writeFileSync(userConfig, "run:\n  mode: supervised\n");
        handOff(props, { kind: "edit-prompt", file });
      },
      (props) => handOff(props, { kind: "exit" }),
    ]);
    await fs.mkdir(path.dirname(userConfig), { recursive: true });
    await fs.writeFile(userConfig, "run:\n  mode: autopilot\n");

    await startTui(projectDir, { runEditor: async () => 0, render: fn });

    expect((renders[1]!.initialConfig as { run: { mode: string } }).run.mode).toBe("supervised");
  });

  it("keeps the previous config and shows a notice when the reload fails", async () => {
    const userConfig = path.join(process.env.ASSENTOR_USER_DIR!, "config.yaml");
    const file = path.join(root, "user", "alpha.md");
    const { fn, renders } = fakeRender([
      (props) => {
        writeFileSync(userConfig, "run: [unclosed\n");
        handOff(props, { kind: "edit-prompt", file });
      },
      (props) => handOff(props, { kind: "exit" }),
    ]);
    await fs.mkdir(path.dirname(userConfig), { recursive: true });
    await fs.writeFile(userConfig, "run:\n  mode: autopilot\n");

    await startTui(projectDir, { runEditor: async () => 0, render: fn });

    expect(renders[1]!.initialConfig).toBe(renders[0]!.initialConfig);
    expect((renders[1]!.initialNotice as string[])[0]).toMatch(/^Could not reload config, keeping the previous one/);
  });

  it("any other handoff is returned unchanged, and no editor runs", async () => {
    const handoff: TuiHandoff = { kind: "run", projectPath: projectDir, prompt: "Add average()" };
    let editorRuns = 0;
    const { fn, renders } = fakeRender([(props) => handOff(props, handoff)]);

    const result = await startTui(projectDir, {
      runEditor: async () => {
        editorRuns += 1;
        return 0;
      },
      render: fn,
    });

    expect(result).toBe(handoff);
    expect(renders).toHaveLength(1);
    expect(editorRuns).toBe(0);
  });
});
