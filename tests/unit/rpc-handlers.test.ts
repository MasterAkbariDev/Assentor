import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEngineRpcServer,
  createInProcessTransport,
  KeyVault,
  RpcClient,
  RpcErrorCode,
  RpcRemoteError,
  RpcServer,
  type CliModelCatalog,
} from "../../packages/engine/src/index.js";
import { SELECTABLE_EXECUTOR_PROVIDERS } from "../../packages/engine/src/executors/providers.js";
import { registerHandlerMethods } from "../../packages/engine/src/rpc/handlers/index.js";
import { RpcMethods } from "../../packages/protocol/src/rpc.js";

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
let projectPath = "";
let home = "";
let userDir = "";

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-handlers-project-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-handlers-home-"));
  dirs.push(projectPath, home);
  userDir = path.join(home, ".assentor");
  await fs.mkdir(userDir, { recursive: true });
  vi.stubEnv("ASSENTOR_USER_DIR", userDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function clientFor(server: RpcServer): RpcClient {
  const { client: transport } = createInProcessTransport(server);
  const client = new RpcClient(transport);
  cleanups.push(() => client.close());
  return client;
}

const engineClient = () => clientFor(createEngineRpcServer({ projectPath, engineVersion: "test" }));

async function rejection(promise: Promise<unknown>): Promise<RpcRemoteError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcRemoteError);
  return error as RpcRemoteError;
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

const frontMatter = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "builder",
  title: `Title ${id}`,
  version: 1,
  variables: ["goal"],
  ...extra,
});

const MOCK_TEAM = { seats: [{ provider: "mock", role: "general" }] };

describe("write access", () => {
  it("marks every mutating or process-starting method as write and the pure reads as read", () => {
    const write = ["prompt.save", "prompt.fork", "team.save", "team.delete", "settings.save", "env.doctor", "env.detectClis", "models.discover"];
    const read = ["prompt.preview", "prompt.validate", "team.validate", "playbook.list", "playbook.get", "settings.get"];
    for (const method of write) expect(RpcMethods[method as keyof typeof RpcMethods].access).toBe("write");
    for (const method of read) expect(RpcMethods[method as keyof typeof RpcMethods].access).toBe("read");
  });

  it("refuses a write method on a connection without write access", async () => {
    const server = createEngineRpcServer({ projectPath, engineVersion: "test" });
    const frames: string[] = [];
    const connection = server.connect((frame) => void frames.push(frame));
    await connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.save", params: {} }));
    expect(JSON.parse(frames[0]!).error.code).toBe(RpcErrorCode.WriteNotAllowed);
  });
});

describe("prompt.save", () => {
  it("saves into the user layer and the prompt is readable afterwards", async () => {
    const client = engineClient();
    const result = await client.call("prompt.save", { scope: "user", frontMatter: frontMatter("my-helper"), body: "Do {{goal}}." });

    expect(result).toEqual({ id: "my-helper", scope: "user" });
    expect(await client.call("prompt.get", { id: "my-helper" })).toMatchObject({ source: "user", body: "Do {{goal}}." });
    expect(await exists(path.join(userDir, "prompts", "my-helper.md"))).toBe(true);
  });

  it("saves into the project layer", async () => {
    const client = engineClient();
    await client.call("prompt.save", { scope: "project", frontMatter: frontMatter("engineer"), body: "Project engineer." });

    expect(await client.call("prompt.get", { id: "engineer" })).toMatchObject({ source: "project", body: "Project engineer." });
  });

  it("rejects the builtin scope and writes nothing", async () => {
    const error = await rejection(
      engineClient().call("prompt.save", { scope: "builtin" as "user", frontMatter: frontMatter("engineer"), body: "x" }),
    );
    expect(error.code).toBe(RpcErrorCode.InvalidParams);
  });

  it("rejects ids that could leave the prompt directory", async () => {
    const client = engineClient();
    for (const id of ["../evil", "..", "a/b", "a\\b", "/etc/passwd", "Evil", ".hidden"]) {
      const error = await rejection(client.call("prompt.save", { scope: "user", frontMatter: frontMatter(id), body: "x" }));
      expect(error.code).toBe(RpcErrorCode.InvalidParams);
    }
    expect(await exists(path.join(userDir, "evil.md"))).toBe(false);
    expect(await exists(path.join(userDir, "prompts"))).toBe(false);
  });

  it("rejects a bad template, an unknown parent and leaves the old file when a save is refused", async () => {
    const client = engineClient();
    await client.call("prompt.save", { scope: "user", frontMatter: frontMatter("keep-me"), body: "original" });

    expect((await rejection(client.call("prompt.save", { scope: "user", frontMatter: frontMatter("keep-me"), body: "{{#each x}}" }))).code).toBe(
      RpcErrorCode.InvalidParams,
    );
    expect(
      (await rejection(client.call("prompt.save", { scope: "user", frontMatter: frontMatter("keep-me", { extends: "no-such-parent" }), body: "x" }))).message,
    ).toContain("unknown prompt");
    expect(await client.call("prompt.get", { id: "keep-me" })).toMatchObject({ body: "original" });
  });

  it("rolls back a prompt the library rejects (extends cycle)", async () => {
    const client = engineClient();
    await client.call("prompt.save", { scope: "user", frontMatter: frontMatter("cycle-a"), body: "a" });
    await client.call("prompt.save", { scope: "user", frontMatter: frontMatter("cycle-b", { extends: "cycle-a" }), body: "b" });

    const error = await rejection(
      client.call("prompt.save", { scope: "user", frontMatter: frontMatter("cycle-a", { extends: "cycle-b" }), body: "a2" }),
    );

    expect(error.message).toContain("Prompt rejected");
    expect(await client.call("prompt.get", { id: "cycle-a" })).toMatchObject({ body: "a" });
  });
});

describe("prompt.save symlinks", () => {
  it("refuses to write through a project prompt directory that points outside the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-handlers-outside-"));
    dirs.push(outside);
    await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
    await fs.symlink(outside, path.join(projectPath, ".assentor", "prompts"));

    const error = await rejection(
      engineClient().call("prompt.save", { scope: "project", frontMatter: frontMatter("sneaky"), body: "x" }),
    );

    expect(error.code).toBe(RpcErrorCode.InvalidParams);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses when .assentor itself is a symlink out of the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-handlers-outside-"));
    dirs.push(outside);
    await fs.symlink(outside, path.join(projectPath, ".assentor"));
    const client = engineClient();
    expect((await rejection(client.call("prompt.save", { scope: "project", frontMatter: frontMatter("sneaky"), body: "x" }))).code).toBe(
      RpcErrorCode.InvalidParams,
    );

    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("allows the user's own symlinked prompt directory", async () => {
    const mine = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-handlers-dotfiles-"));
    dirs.push(mine);
    await fs.symlink(mine, path.join(userDir, "prompts"));

    await engineClient().call("prompt.save", { scope: "user", frontMatter: frontMatter("mine"), body: "x" });

    expect(await fs.readdir(mine)).toEqual(["mine.md"]);
  });

  it("leaves no temp file behind when the write fails", async () => {
    const dir = path.join(userDir, "prompts");
    await fs.mkdir(dir, { recursive: true });
    // A directory where the prompt file should go: rename onto it fails.
    await fs.mkdir(path.join(dir, "blocked.md"));

    await rejection(engineClient().call("prompt.save", { scope: "user", frontMatter: frontMatter("blocked"), body: "x" }));

    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("prompt.fork", () => {
  it("copies a built-in prompt under a new id in the user layer", async () => {
    const client = engineClient();
    const original = await client.call("prompt.get", { id: "engineer" });

    expect(await client.call("prompt.fork", { id: "engineer", scope: "user", newId: "my-engineer" })).toEqual({ id: "my-engineer", scope: "user" });

    expect(await client.call("prompt.get", { id: "my-engineer" })).toMatchObject({ source: "user", body: original.body, role: original.role });
  });

  it("overrides in a layer with the same id, refuses to overwrite, and rejects bad ids", async () => {
    const client = engineClient();
    await client.call("prompt.fork", { id: "engineer", scope: "project" });
    expect(await client.call("prompt.get", { id: "engineer" })).toMatchObject({ source: "project" });

    expect((await rejection(client.call("prompt.fork", { id: "engineer", scope: "project" }))).message).toContain("already exists");
    expect((await rejection(client.call("prompt.fork", { id: "nope", scope: "user" }))).code).toBe(RpcErrorCode.InvalidParams);
    expect((await rejection(client.call("prompt.fork", { id: "engineer", scope: "user", newId: "../x" }))).code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("prompt.preview", () => {
  it("renders with variables, with an unsaved body, and reports the missing ones", async () => {
    const client = engineClient();
    await client.call("prompt.save", { scope: "user", frontMatter: frontMatter("greeter", { variables: ["name"] }), body: "Hello {{name}}!" });

    expect(await client.call("prompt.preview", { id: "greeter", variables: { name: "Ada" } })).toEqual({ ok: true, text: "Hello Ada!", missing: [] });
    expect(await client.call("prompt.preview", { id: "greeter", variables: { name: "Ada" }, body: "Bye {{name}}" })).toMatchObject({ text: "Bye Ada" });
    expect(await client.call("prompt.preview", { id: "greeter" })).toMatchObject({ ok: false, missing: ["name"] });
    expect((await rejection(client.call("prompt.preview", { id: "nope" }))).code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("prompt.validate", () => {
  it("returns problems, the variables the body reads and the undeclared ones", async () => {
    const client = engineClient();
    expect(await client.call("prompt.validate", { frontMatter: frontMatter("ok-one"), body: "{{goal}} {{extra}}" })).toEqual({
      ok: true,
      problems: [],
      variables: ["goal", "extra"],
      undeclared: ["extra"],
    });

    const bad = await client.call("prompt.validate", { frontMatter: { id: "Bad Id" }, body: "{{#each x}}" });
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBe(2);
  });
});

describe("team.*", () => {
  it("validates, saves, lists and deletes a team", async () => {
    const client = engineClient();

    expect(await client.call("team.validate", { team: MOCK_TEAM })).toEqual({ ok: true, problems: [] });
    const bad = await client.call("team.validate", { team: { seats: [{ provider: "mock", model: "-rf" }] } });
    expect(bad.ok).toBe(false);
    expect((await client.call("team.validate", { team: { seats: [] } })).ok).toBe(false);

    expect(await client.call("team.save", { name: "my-team", team: { description: "mine", ...MOCK_TEAM } })).toEqual({ name: "my-team" });
    const listed = await client.call("team.list");
    expect(listed.teams.find((team) => team.name === "my-team")).toMatchObject({ description: "mine", source: "config" });

    expect(await client.call("team.delete", { name: "my-team" })).toEqual({ name: "my-team" });
    expect((await client.call("team.list")).teams.some((team) => team.name === "my-team")).toBe(false);
  });

  it("rejects bad names and bad seats on save", async () => {
    const client = engineClient();
    for (const name of ["../evil", "__proto__", "A b"]) {
      expect((await rejection(client.call("team.save", { name, team: MOCK_TEAM }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    expect((await rejection(client.call("team.save", { name: "x", team: { seats: [{ provider: "mock", model: "--evil" }] } }))).code).toBe(
      RpcErrorCode.InvalidParams,
    );
  });

  it("refuses to delete a team that modes use and lists the references", async () => {
    await fs.writeFile(
      path.join(userDir, "config.yaml"),
      "teams:\n  used:\n    seats:\n      - provider: mock\n  free:\n    seats:\n      - provider: mock\nmodes:\n  review:\n    team: used\n",
    );
    const client = engineClient();

    const error = await rejection(client.call("team.delete", { name: "used" }));

    expect(error.code).toBe(RpcErrorCode.InvalidParams);
    expect(error.message).toContain("modes.review.team");
    expect(error.data).toEqual({ references: ["modes.review.team"] });
    expect((await client.call("team.list")).teams.map((team) => team.name)).toContain("used");

    await client.call("team.delete", { name: "free" });
    const config = await fs.readFile(path.join(userDir, "config.yaml"), "utf8");
    expect(config).toContain("used:");
    expect(config).not.toContain("free:");
    expect(config).toContain("review:");
  });

  it("refuses to delete a team a playbook stage names", async () => {
    await fs.writeFile(path.join(userDir, "config.yaml"), "teams:\n  auditors:\n    seats:\n      - provider: mock\n");
    const client = engineClient();

    const error = await rejection(client.call("team.delete", { name: "auditors" }));

    expect(error.message).toContain("playbook security-audit");
    expect((error.data as { references: string[] }).references.some((ref) => ref.startsWith("playbook "))).toBe(true);
  });

  it("refuses to save a user team the project already defines", async () => {
    await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".assentor", "config.yaml"), "teams:\n  proj:\n    seats:\n      - provider: mock\n");

    expect((await rejection(engineClient().call("team.save", { name: "proj", team: MOCK_TEAM }))).message).toContain("project config");
  });

  it("keeps both changes when saves run at the same time", async () => {
    const client = engineClient();

    await Promise.all([
      client.call("team.save", { name: "team-a", team: MOCK_TEAM }),
      client.call("team.save", { name: "team-b", team: MOCK_TEAM }),
      client.call("settings.save", { settings: { routing: { strategy: "BEST" } } }),
      client.call("team.save", { name: "team-c", team: MOCK_TEAM }),
      client.call("settings.save", { settings: { git: { autoCommit: true } } }),
    ]);

    const names = (await client.call("team.list")).teams.map((team) => team.name);
    expect(names).toEqual(expect.arrayContaining(["team-a", "team-b", "team-c"]));
    expect(await client.call("settings.get")).toMatchObject({ settings: { routing: { strategy: "BEST" }, git: { autoCommit: true } } });
    expect((await fs.readdir(userDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("explains an unknown team and a team that only the project defines", async () => {
    await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".assentor", "config.yaml"), "teams:\n  proj:\n    seats:\n      - provider: mock\n");
    const client = engineClient();

    expect((await rejection(client.call("team.delete", { name: "proj" }))).message).toContain("project config");
    expect((await rejection(client.call("team.delete", { name: "ghost" }))).message).toContain("Unknown team");
  });
});

describe("playbook.*", () => {
  it("lists the built-in playbooks and returns one with its stages", async () => {
    const client = engineClient();
    const { playbooks, errors } = await client.call("playbook.list");

    expect(errors).toEqual([]);
    expect(playbooks.length).toBeGreaterThan(0);
    const first = playbooks[0]!;
    expect(first).toMatchObject({ source: "builtin", overridden: false });

    const full = await client.call("playbook.get", { id: first.id });
    expect(full.id).toBe(first.id);
    expect(full.stages.length).toBeGreaterThan(0);
    expect(JSON.stringify(full)).not.toContain(os.homedir());
  });

  it("rejects an unknown id and a path-like id without touching the filesystem", async () => {
    const client = engineClient();
    for (const id of ["nope", "../../etc/passwd", "..\\x"]) {
      expect((await rejection(client.call("playbook.get", { id }))).code).toBe(RpcErrorCode.InvalidParams);
    }
  });
});

describe("settings.*", () => {
  it("never returns a secret: keys are { id, provider, name, healthy } only", async () => {
    const secret = "sk-test-SUPERSECRET-1234567890abcdef";
    const vault = new KeyVault(home);
    await vault.load();
    const stored = await vault.add({ provider: "openai", name: "work", secret });
    const server = createEngineRpcServer({ projectPath, engineVersion: "test" });
    const client = clientFor(server);

    const result = await client.call("settings.get");
    const json = JSON.stringify(result);

    expect(result.keys).toEqual([{ id: stored.id, provider: "openai", name: "work", healthy: false }]);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(stored.masked);
    expect(json).not.toContain(stored.ciphertext);
    expect(json).not.toMatch(/secret|ciphertext|masked|keyId|binaries/i);
    expect(result.settings.executor.provider).toBe("mock");
  });

  it("settings.get has no side effects: no master key is created and the vault file is untouched", async () => {
    const row = { id: "k1", provider: "openai", name: "work", masked: "sk-t...cdef", ciphertext: "AAAA", enabled: true, priority: 1, health: "healthy", failureCount: 0 };
    // Two identical rows: KeyVault.load would dedupe and rewrite the file.
    const before = `${JSON.stringify({ version: 1, keys: [row, { ...row, id: "k2", priority: 2 }] }, null, 2)}\n`;
    await fs.writeFile(path.join(userDir, "secrets.json"), before);

    const result = await engineClient().call("settings.get");

    expect(result.keys).toEqual([
      { id: "k1", provider: "openai", name: "work", healthy: true },
      { id: "k2", provider: "openai", name: "work", healthy: true },
    ]);
    expect(await fs.readFile(path.join(userDir, "secrets.json"), "utf8")).toBe(before);
    expect(await exists(path.join(userDir, ".master.key"))).toBe(false);
  });

  it("settings.get with no vault file lists no keys", async () => {
    expect((await engineClient().call("settings.get")).keys).toEqual([]);
  });

  it("settings.save returns the merged settings, like settings.get", async () => {
    await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".assentor", "config.yaml"), "limits:\n  maxRounds: 2\n");
    const client = engineClient();

    const saved = await client.call("settings.save", { settings: { git: { autoCommit: true } } });

    expect(saved).toEqual({ settings: (await client.call("settings.get")).settings });
    expect(saved.settings.limits.maxRounds).toBe(2);
  });

  it("refuses flag-like executor models and providers the engine cannot select", async () => {
    const client = engineClient();
    for (const executor of [{ model: "--yolo" }, { model: "-rf" }, { provider: "project-mutating" }, { provider: "../x" }]) {
      expect((await rejection(client.call("settings.save", { settings: { executor } as never }))).code).toBe(RpcErrorCode.InvalidParams);
    }
    await client.call("settings.save", { settings: { executor: { provider: "codex", model: "gpt-5" } } });
    expect((await client.call("settings.get")).settings.executor).toEqual({ provider: "codex", model: "gpt-5" });
  });

  it("accepts every provider the engine can select", () => {
    for (const provider of SELECTABLE_EXECUTOR_PROVIDERS) {
      expect(RpcMethods["settings.save"].params.safeParse({ settings: { executor: { provider } } }).success).toBe(true);
    }
  });

  it("saves only the given fields to the user config and keeps teams and modes", async () => {
    await fs.writeFile(
      path.join(userDir, "config.yaml"),
      "teams:\n  t:\n    seats:\n      - provider: mock\nmodes:\n  review:\n    team: t\n",
    );
    const client = engineClient();

    const saved = await client.call("settings.save", {
      settings: { routing: { strategy: "BEST" }, limits: { maxRounds: 3 }, run: { autonomy: "autopilot" } },
    });

    expect(saved.settings).toMatchObject({ routing: { strategy: "BEST", reviewStrategy: "ADAPTIVE" }, limits: { maxRounds: 3 }, run: { autonomy: "autopilot" } });
    expect(await client.call("settings.get")).toMatchObject({ settings: { routing: { strategy: "BEST" }, run: { autonomy: "autopilot" } } });
    const file = await fs.readFile(path.join(userDir, "config.yaml"), "utf8");
    expect(file).toContain("team: t");
    expect(file).toContain("seats:");
  });

  it("does not copy project values into the user file, and rejects invalid or unsafe fields", async () => {
    await fs.mkdir(path.join(projectPath, ".assentor"), { recursive: true });
    await fs.writeFile(path.join(projectPath, ".assentor", "config.yaml"), "limits:\n  maxRounds: 2\n");
    const client = engineClient();

    await client.call("settings.save", { settings: { git: { autoCommit: true } } });
    expect(await fs.readFile(path.join(userDir, "config.yaml"), "utf8")).not.toMatch(/maxRounds: 2\b/);

    expect((await rejection(client.call("settings.save", { settings: { executor: { provider: "no-such-cli" } } } as never))).code).toBe(RpcErrorCode.InvalidParams);
    expect(
      (await rejection(client.call("settings.save", { settings: { binaries: { claude: "/tmp/evil" } } } as never))).code,
    ).toBe(RpcErrorCode.InvalidParams);
    expect((await rejection(client.call("settings.save", { settings: { limits: { maxRounds: -1 } } }))).code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("env.* and models.discover", () => {
  function injected(overrides: Parameters<typeof registerHandlerMethods>[1]) {
    return clientFor(registerHandlerMethods(new RpcServer(), overrides));
  }

  it("env.doctor returns the diagnostics with paths scrubbed", async () => {
    const client = injected({
      projectPath,
      runDiagnostics: async () => [{ name: "executor:x", ok: true, detail: `Installed at ${projectPath}/bin/x` }],
    });

    const { items } = await client.call("env.doctor");

    expect(items).toEqual([{ name: "executor:x", ok: true, detail: "Installed at <project>/bin/x" }]);
  });

  it("env.doctor redacts key-like tokens in provider messages", async () => {
    const client = injected({
      projectPath,
      runDiagnostics: async () => [{ name: "key:work", ok: false, detail: "rejected sk-abcdefghijklmnopqrstuvwxyz123456 by provider" }],
    });

    const { items } = await client.call("env.doctor");

    expect(items[0]!.detail).toBe("rejected [REDACTED] by provider");
  });

  it("env.detectClis returns install state without the binary path", async () => {
    const client = injected({
      projectPath,
      detectClis: async () => [
        { id: "claude", name: "Claude", detection: { installed: true, available: true, path: "/usr/local/bin/claude", version: "1.2.3", authenticated: true } },
        { id: "agy", name: "Antigravity", detection: { installed: false, available: false, error: "not found" } },
      ],
    });

    const { clis } = await client.call("env.detectClis");

    expect(clis).toEqual([
      { id: "claude", name: "Claude", installed: true, available: true, version: "1.2.3", authenticated: true },
      { id: "agy", name: "Antigravity", installed: false, available: false, error: "not found" },
    ]);
  });

  it("models.discover returns the discovered entries and any error", async () => {
    const client = injected({
      projectPath,
      createCatalog: () =>
        ({
          discover: async () => ({
            entries: [{ provider: "cursor", id: "m-1", label: "M 1", source: "discovered" }],
            error: "cache could not be saved",
          }),
        }) as unknown as CliModelCatalog,
    });

    expect(await client.call("models.discover", { provider: "cursor" })).toEqual({
      entries: [{ id: "m-1", label: "M 1", source: "discovered" }],
      error: "cache could not be saved",
    });
  });
});
