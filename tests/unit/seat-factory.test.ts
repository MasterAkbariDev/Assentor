import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CliReviewer,
  createEmptyContract,
  EventLog,
  MockReviewer,
  TeamSchema,
  type CliSpawnRequest,
  type Reviewer,
  type TeamInput,
} from "../../src/index.js";
import {
  assertReadOnlyReviewerArgs,
  resolveCliAdapter,
} from "../../src/providers/reviewers/cli/index.js";
import {
  createReviewerSeats,
  reviewTeamTargets,
  type ReviewerSeatRequest,
} from "../../src/seats/index.js";
import { runAssentorTask } from "../../src/cli/commands.js";

const PASS_JSON = JSON.stringify({
  status: "PASS",
  confidence: 0.9,
  summary: "ok",
  issues: [],
  requiredChanges: [],
  optionalChanges: [],
  evidenceRequests: [],
});

const FORBIDDEN = /dangerously|bypass|yolo|--force|full-auto/i;

function reviewInput() {
  return {
    taskId: "t-seats",
    projectPath: "/tmp/assentor-seat-factory",
    contract: createEmptyContract("Implement average()"),
    round: 1,
    artifacts: [],
  };
}

/** Builds real CliReviewers whose spawned args are recorded instead of run. */
function recordingDeps(spawned: Array<{ name: string; args: string[] }>) {
  const requests: ReviewerSeatRequest[] = [];
  const createReviewer = async (request: ReviewerSeatRequest): Promise<Reviewer> => {
    requests.push(request);
    if (request.transport === "api") {
      return new MockReviewer({ name: request.name, steps: [{ type: "pass" }] });
    }
    return new CliReviewer({
      name: request.name,
      adapter: resolveCliAdapter(request.provider),
      binary: request.provider,
      model: request.model,
      spawnFn: async (spawn: CliSpawnRequest) => {
        spawned.push({ name: request.name, args: spawn.args });
        return { code: 0, stdout: PASS_JSON, stderr: "" };
      },
    });
  };
  return { requests, createReviewer };
}

function team(input: TeamInput) {
  return TeamSchema.parse(input);
}

describe("createReviewerSeats", () => {
  it("expands a team of three Opus seats into Opus#1..3, each passing --model opus", async () => {
    const spawned: Array<{ name: string; args: string[] }> = [];
    const { createReviewer } = recordingDeps(spawned);

    const seats = await createReviewerSeats(
      team({ seats: [{ provider: "claude-code", model: "opus", count: 3 }] }),
      { createReviewer },
    );

    expect(seats.map((s) => s.reviewer.name)).toEqual(["Opus#1", "Opus#2", "Opus#3"]);
    expect(seats.map((s) => s.seat.id)).toEqual(["opus-1", "opus-2", "opus-3"]);
    for (const { reviewer } of seats) {
      await reviewer.review(reviewInput());
    }
    expect(spawned).toHaveLength(3);
    for (const { args } of spawned) {
      expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "text", "--model", "opus"]);
    }
  });

  it("gives each transport its own reviewer and API keys only to API seats", async () => {
    const spawned: Array<{ name: string; args: string[] }> = [];
    const { requests, createReviewer } = recordingDeps(spawned);
    const keyCalls: string[] = [];

    const seats = await createReviewerSeats(
      team({
        seats: [
          { provider: "claude-code", model: "AUTO" },
          { provider: "gemini", model: "AUTO" },
          { provider: "openai", model: "gpt-5" },
          { provider: "mock" },
        ],
      }),
      {
        createReviewer,
        resolveApiKey: async (provider) => {
          keyCalls.push(provider);
          return `key-for-${provider}`;
        },
        defaultApiModel: (provider) => (provider === "gemini" ? "gemini-2.5-pro" : undefined),
      },
    );

    expect(seats.map((s) => [s.seat.provider, s.seat.transport])).toEqual([
      ["claude-code", "cli"],
      ["gemini", "api"],
      ["openai", "api"],
      ["mock", "api"],
    ]);
    expect(keyCalls).toEqual(["gemini", "openai"]);
    expect(requests.map((r) => [r.provider, r.transport, r.model, r.apiKey])).toEqual([
      ["claude", "cli", undefined, undefined],
      ["gemini", "api", "gemini-2.5-pro", "key-for-gemini"],
      ["openai", "api", "gpt-5", "key-for-openai"],
      ["mock", "api", undefined, undefined],
    ]);
  });

  it("downgrades an edit review seat to read-only with a warning", async () => {
    const warnings: string[] = [];
    const { createReviewer } = recordingDeps([]);
    const seats = await createReviewerSeats(
      team({ seats: [{ provider: "codex", permissions: "edit", name: "Sol" }] }),
      { createReviewer, onWarning: (message) => warnings.push(message) },
    );
    expect(seats[0]!.seat.permissions).toBe("read-only");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Sol#1");
  });

  it("rejects a provider without a reviewer adapter before creating any reviewer", async () => {
    const { requests, createReviewer } = recordingDeps([]);
    await expect(
      createReviewerSeats(
        team({ seats: [{ provider: "claude-code" }, { provider: "qwen" }] }),
        { createReviewer },
      ),
    ).rejects.toThrow(/qwen/);
    expect(requests).toEqual([]);
  });

  it("maps seats to reviewer provider ids for preflight", () => {
    expect(
      reviewTeamTargets(
        team({ seats: [{ provider: "claude", count: 2 }, { provider: "gemini" }] }),
      ),
    ).toEqual([
      { provider: "claude", transport: "cli" },
      { provider: "claude", transport: "cli" },
      { provider: "gemini", transport: "api" },
    ]);
  });
});

describe("CLI reviewers stay read-only", () => {
  it("never passes edit or bypass flags, for every CLI adapter", async () => {
    const spawned: Array<{ name: string; args: string[] }> = [];
    const { createReviewer } = recordingDeps(spawned);
    const seats = await createReviewerSeats(
      team({
        seats: [
          { provider: "claude-code", model: "opus" },
          { provider: "codex", model: "o3" },
          { provider: "cursor", model: "gpt-5" },
          { provider: "antigravity", model: "gemini-3-pro" },
        ],
      }),
      { createReviewer },
    );
    for (const { reviewer } of seats) {
      await reviewer.review(reviewInput());
    }

    expect(spawned).toHaveLength(4);
    for (const { args } of spawned) {
      // The last arg is the prompt (antigravity attaches it as -p=...).
      expect(args.slice(0, -1).filter((arg) => FORBIDDEN.test(arg))).toEqual([]);
    }
  });

  it("runs codex as `exec --sandbox read-only --skip-git-repo-check -m <model> <prompt>`", async () => {
    const spawned: Array<{ name: string; args: string[] }> = [];
    const { createReviewer } = recordingDeps(spawned);
    const [seat] = await createReviewerSeats(
      team({ seats: [{ provider: "codex", model: "o3" }] }),
      { createReviewer },
    );
    await seat!.reviewer.review(reviewInput());
    // The sandbox is pinned on the command line so ~/.codex/config.toml can't widen it.
    expect(spawned[0]!.args.slice(0, 6)).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-m",
      "o3",
    ]);
    expect(spawned[0]!.args).toHaveLength(7);
  });

  it("refuses extra args that would grant edit rights", () => {
    expect(() => assertReadOnlyReviewerArgs(["--dangerously-skip-permissions"])).toThrow();
    expect(() => assertReadOnlyReviewerArgs(["--yolo"])).toThrow();
    expect(() => assertReadOnlyReviewerArgs(["--full-auto"])).toThrow();
    for (const flag of [
      "--force",
      "-f",
      "--approve-for-me",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "-s",
      "danger-full-access",
      "workspace-write",
      "--sandbox",
    ]) {
      expect(() => assertReadOnlyReviewerArgs([flag]), flag).toThrow();
    }
    expect(() => assertReadOnlyReviewerArgs(["--verbose"])).not.toThrow();
    expect(
      () => new CliReviewer({ adapter: "claude", binary: "claude", extraArgs: ["--yolo"] }),
    ).toThrow(/yolo/);
  });
});

describe("assentor run with a review team", () => {
  let projectDir: string;
  let userDir: string;
  const savedUserDir = process.env.ASSENTOR_USER_DIR;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "seat-factory-run-"));
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), "seat-factory-user-"));
    process.env.ASSENTOR_USER_DIR = path.join(userDir, ".assentor");
    await fs.mkdir(path.join(projectDir, ".assentor"), { recursive: true });
  });

  afterEach(async () => {
    if (savedUserDir === undefined) {
      delete process.env.ASSENTOR_USER_DIR;
    } else {
      process.env.ASSENTOR_USER_DIR = savedUserDir;
    }
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userDir, { recursive: true, force: true });
  });

  async function run(configYaml: string) {
    await fs.writeFile(path.join(projectDir, ".assentor", "config.yaml"), configYaml, "utf8");
    const { result } = await runAssentorTask({
      projectPath: projectDir,
      prompt: "Implement average()",
      skipPreflight: true,
      skipGates: true,
    });
    const events = await (await EventLog.open(projectDir, result.taskId)).readFrom(0);
    return events
      .filter((e) => e.type === "seat.spawned" && e.seatId?.startsWith("reviewer-"))
      .map((e) => (e.data as { displayName: string }).displayName);
  }

  it("builds one reviewer per team seat, even with reviewStrategy SINGLE", async () => {
    const names = await run(
      [
        "git:\n  checkpoints: false",
        "executor:\n  provider: mock",
        "routing:\n  reviewStrategy: SINGLE",
        "teams:\n  panel:\n    seats:\n      - provider: mock\n        count: 2",
        "modes:\n  review:\n    team: panel",
        "",
      ].join("\n"),
    );
    expect(names).toEqual(["Mock#1", "Mock#2"]);
  });

  it("keeps the legacy reviewers path when no review team is set", async () => {
    const names = await run(
      [
        "git:\n  checkpoints: false",
        "executor:\n  provider: mock",
        "reviewers:\n  - provider: mock\n  - provider: mock\n    name: second",
        "",
      ].join("\n"),
    );
    expect(names).toHaveLength(2);
    expect(names[1]).toBe("second");
    expect(names.some((name) => name.includes("#"))).toBe(false);
  });

  it("matches the v0.3.19 reviewer seats for a legacy config", async () => {
    await fs.writeFile(
      path.join(projectDir, ".assentor", "config.yaml"),
      [
        "git:\n  checkpoints: false",
        "executor:\n  provider: mock",
        "reviewers:\n  - provider: mock\n  - provider: mock\n    name: second\n    role: security",
        "",
      ].join("\n"),
      "utf8",
    );
    const { result } = await runAssentorTask({
      projectPath: projectDir,
      prompt: "Implement average()",
      skipPreflight: true,
      skipGates: true,
    });
    const events = await (await EventLog.open(projectDir, result.taskId)).readFrom(0);
    const seats = events
      .filter((e) => e.type === "seat.spawned")
      .map((e) => ({ seatId: e.seatId, ...(e.data as Record<string, unknown>) }));
    // Names and roles come from the legacy profile mapping, unchanged by T01-02.
    expect(seats).toEqual([
      expect.objectContaining({ seatId: "executor", provider: "mock", permissions: "edit" }),
      expect.objectContaining({ seatId: "panel", provider: "panel" }),
      expect.objectContaining({
        seatId: "reviewer-1",
        provider: "mock",
        transport: "api",
        model: "AUTO",
        role: "general",
        permissions: "read-only",
      }),
      expect.objectContaining({
        seatId: "reviewer-2",
        displayName: "second",
        provider: "mock",
        transport: "api",
        model: "AUTO",
        role: "security",
        permissions: "read-only",
      }),
    ]);
  });
});
