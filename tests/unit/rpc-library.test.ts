import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CliModelCatalog,
  createEngineRpcServer,
  createInProcessTransport,
  PromptLibrary,
  RpcClient,
  RpcErrorCode,
  RpcRemoteError,
  RpcServer,
} from "../../packages/engine/src/index.js";
import { registerLibraryMethods } from "../../packages/engine/src/rpc/library.js";

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Each test gets its own project and its own user dir, so no real `~/.assentor` is read. */
let projectPath = "";
let userDir = "";

beforeEach(async () => {
  projectPath = await tempDir("rpc-library-project-");
  userDir = await tempDir("rpc-library-user-");
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

function engineClient(): RpcClient {
  return clientFor(createEngineRpcServer({ projectPath, engineVersion: "test" }));
}

async function writeProjectFile(relative: string, text: string): Promise<void> {
  const file = path.join(projectPath, ".assentor", relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

const OVERRIDE_ENGINEER = `---
id: engineer
role: builder
title: Project engineer
version: 1
---
Project body for the engineer.
`;

describe("prompt.list", () => {
  it("lists the built-in prompts", async () => {
    const result = await engineClient().call("prompt.list");

    const engineer = result.prompts.find((prompt) => prompt.id === "engineer");
    expect(engineer).toMatchObject({ source: "builtin", overridden: false, role: "builder" });
    expect(result.errors).toEqual([]);
  });

  it("marks a project override as overridden and from the project layer", async () => {
    await writeProjectFile("prompts/engineer.md", OVERRIDE_ENGINEER);

    const result = await engineClient().call("prompt.list");

    expect(result.prompts.find((prompt) => prompt.id === "engineer")).toMatchObject({
      title: "Project engineer",
      source: "project",
      overridden: true,
    });
  });

  it("reports a broken prompt file under errors without breaking the list", async () => {
    await writeProjectFile(
      "prompts/broken.md",
      `---\nid: not-broken\nrole: builder\ntitle: Broken\nversion: 1\n---\nbody\n`,
    );

    const result = await engineClient().call("prompt.list");

    expect(result.prompts.some((prompt) => prompt.id === "engineer")).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({
        file: "broken.md",
        message: expect.stringContaining("front-matter id must match the file name"),
      }),
    ]);
  });

  it("never returns an absolute path in errors", async () => {
    await writeProjectFile("prompts/broken.md", "no front matter at all\n");

    const result = await engineClient().call("prompt.list");
    const json = JSON.stringify(result);

    expect(result.errors.map((error) => error.file)).toEqual(["broken.md"]);
    expect(json).not.toContain(projectPath);
    expect(json).not.toContain(userDir);
  });
});

describe("prompt.get", () => {
  it("returns the front-matter and body of a prompt without file paths", async () => {
    await writeProjectFile("prompts/engineer.md", OVERRIDE_ENGINEER);

    const result = await engineClient().call("prompt.get", { id: "engineer" });

    expect(result).toMatchObject({
      id: "engineer",
      title: "Project engineer",
      role: "builder",
      source: "project",
      body: "Project body for the engineer.",
      frontMatter: expect.objectContaining({ id: "engineer", version: 1 }),
    });
    expect(result.frontMatter).not.toHaveProperty("file");
    expect(result.frontMatter).not.toHaveProperty("layer");
    expect(JSON.stringify(result)).not.toContain(projectPath);
  });

  it("raises InvalidParams for an unknown id", async () => {
    const client = engineClient();

    const error = await client.call("prompt.get", { id: "no-such-prompt" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcRemoteError);
    expect((error as RpcRemoteError).code).toBe(RpcErrorCode.InvalidParams);
    expect((error as RpcRemoteError).message).toBe("Unknown prompt no-such-prompt");
  });
});

describe("team.list", () => {
  it("expands configured teams and includes the legacy review team when modes.review is unset", async () => {
    await writeProjectFile(
      "config.yaml",
      [
        "teams:",
        "  panel:",
        "    description: Two reviewers",
        "    seats:",
        "      - provider: mock",
        "        count: 2",
        "        role: reviewer",
        "",
      ].join("\n"),
    );

    const result = await engineClient().call("team.list");

    const panel = result.teams.find((team) => team.name === "panel");
    expect(panel).toMatchObject({ source: "config", description: "Two reviewers" });
    expect(panel?.seats).toHaveLength(2);
    expect(panel?.seats[0]).toMatchObject({
      provider: "mock",
      role: "reviewer",
      permissions: "read-only",
    });
    expect(result.teams.find((team) => team.source === "legacy-review")).toBeDefined();
    expect(result.modes).toEqual({});
  });

  it("omits the legacy review team when modes.review names a team", async () => {
    await writeProjectFile(
      "config.yaml",
      [
        "teams:",
        "  panel:",
        "    seats:",
        "      - provider: mock",
        "        role: reviewer",
        "modes:",
        "  review:",
        "    team: panel",
        "",
      ].join("\n"),
    );

    const result = await engineClient().call("team.list");

    expect(result.teams.map((team) => team.source)).toEqual(["config"]);
    expect(result.modes).toEqual({ review: "panel" });
  });

  it("reports an unknown modes.review.team as InvalidRequest without paths", async () => {
    await writeProjectFile("config.yaml", "modes:\n  review:\n    team: ghost\n");

    const error = await engineClient()
      .call("team.list")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcRemoteError);
    expect((error as RpcRemoteError).code).toBe(RpcErrorCode.InvalidRequest);
    expect((error as RpcRemoteError).message).toMatch(/^Config problem: Unknown team "ghost" in modes\.review/);
    expect((error as RpcRemoteError).message).not.toContain(projectPath);
  });

  it("never includes a keyId, even from an API reviewer that has one", async () => {
    await writeProjectFile(
      "config.yaml",
      ["reviewers:", "  - provider: gemini", "    transport: api", "    keyId: vault-key-secret-42", ""].join("\n"),
    );

    const result = await engineClient().call("team.list");
    const json = JSON.stringify(result);

    expect(result.teams.find((team) => team.source === "legacy-review")?.seats[0]).toMatchObject({
      provider: "gemini",
      transport: "api",
    });
    expect(json).not.toContain("keyId");
    expect(json).not.toContain("vault-key-secret-42");
  });
});

describe("models.catalog", () => {
  it("reads the cache only and never spawns a discovery process", async () => {
    const run = vi.fn();
    const catalog = new CliModelCatalog({
      cachePath: path.join(userDir, "models-cache.json"),
      run,
      locate: () => undefined,
    });
    const server = registerLibraryMethods(new RpcServer(), {
      projectPath,
      createCatalog: () => catalog,
    });

    const result = await clientFor(server).call("models.catalog", { provider: "claude-code" });

    expect(result.entries[0]).toEqual({ id: "AUTO", label: expect.any(String), source: "seed" });
    expect(result.entries.every((entry) => entry.id.length > 0)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("never writes the cache: a corrupt or wrong-shape file is left alone and seeds still come back", async () => {
    const cache = path.join(userDir, "models-cache.json");
    for (const corrupt of ["{ not json", "[1, 2, 3]"]) {
      await fs.writeFile(cache, corrupt, "utf8");

      const result = await engineClient().call("models.catalog", { provider: "claude-code" });

      expect(result.entries[0]).toMatchObject({ id: "AUTO", source: "seed" });
      expect(result.entries.length).toBeGreaterThan(1);
      expect((await fs.readdir(userDir)).filter((name) => name.includes(".corrupt-"))).toEqual([]);
      expect(await fs.readFile(cache, "utf8")).toBe(corrupt);
    }
  });

  it("returns InvalidParams for an unknown provider", async () => {
    const error = await engineClient()
      .call("models.catalog", { provider: "not-a-provider" as never })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcRemoteError);
    expect((error as RpcRemoteError).code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("unknown params", () => {
  it("are rejected for every new method", async () => {
    const client = engineClient();

    const rejects = [
      client.call("prompt.list", { extra: true }),
      client.call("prompt.get", { id: "engineer", extra: true } as never),
      client.call("team.list", { extra: true }),
      client.call("models.catalog", { provider: "mock", extra: true } as never),
    ];
    for (const call of rejects) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcRemoteError);
      expect((error as RpcRemoteError).code).toBe(RpcErrorCode.InvalidParams);
    }
  });
});

describe("builtin prompt library", () => {
  it("matches the engine's view of the built-in layer", async () => {
    const library = await PromptLibrary.load({ projectPath });
    const result = await engineClient().call("prompt.list");

    const builtinIds = library
      .list()
      .filter((prompt) => prompt.layer === "builtin")
      .map((prompt) => prompt.id);
    expect(result.prompts.filter((prompt) => prompt.source === "builtin").map((p) => p.id)).toEqual(
      builtinIds,
    );
  });
});

describe("read-only catalog", () => {
  it("refuses every write and never spawns, and creates no file", async () => {
    const cachePath = path.join(userDir, "models-cache.json");
    const run = vi.fn();
    const catalog = new CliModelCatalog({
      cachePath,
      run,
      locate: () => "/usr/bin/fake",
      readOnly: true,
    });

    await expect(catalog.addUserModel("claude-code", "my-model")).rejects.toThrow("read-only catalog");
    await expect(catalog.removeUserModel("claude-code", "my-model")).rejects.toThrow("read-only catalog");
    await expect(catalog.discover("claude-code")).rejects.toThrow("read-only catalog");
    expect(run).not.toHaveBeenCalled();
    await expect(fs.access(cachePath)).rejects.toThrow();
  });
});
