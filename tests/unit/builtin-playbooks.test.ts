import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandSeatSpecs, type StageSpec } from "../../src/core/seats.js";
import {
  builtinPlaybookDir,
  PlaybookLibrary,
  sessionSpecFor,
  type Playbook,
  type PlaybookDefinition,
} from "../../src/playbooks/library.js";
import { createStageRunners } from "../../src/orchestrator/session-stages.js";
import type { SeatScheduler } from "../../src/seats/scheduler.js";
import { PromptLibrary, builtinPromptDir } from "../../src/prompts/index.js";
import { validateSessionGraph } from "../../src/orchestrator/session-runner.js";

const EXPECTED_IDS = [
  "bug-hunt",
  "explain-codebase",
  "explore",
  "feature-build",
  "incident-debug",
  "migrate-dependency",
  "pipeline",
  "plan",
  "pr-review",
  "refactor-safely",
  "security-audit",
  "write-tests",
];
const READ_ONLY_IDS = ["explain-codebase", "explore", "plan", "pr-review", "security-audit"];

describe("built-in playbooks", () => {
  let root: string;
  let prompts: PromptLibrary;
  let library: PlaybookLibrary;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "builtin-playbooks-"));
    const emptyUser = path.join(root, "user");
    await fs.mkdir(emptyUser);
    prompts = await PromptLibrary.load({ builtinDir: builtinPromptDir(), userDir: emptyUser });
    library = await PlaybookLibrary.load({
      builtinDir: builtinPlaybookDir(),
      userDir: emptyUser,
      prompts,
    });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function all(): PlaybookDefinition[] {
    return library.list();
  }

  it("loads every built-in file without errors", () => {
    expect(library.errors).toEqual([]);
    expect(all().map((playbook) => playbook.id)).toEqual(EXPECTED_IDS);
    for (const playbook of all()) {
      expect(playbook.layer).toBe("builtin");
      expect(playbook.title.length).toBeGreaterThan(0);
      expect(playbook.description.length).toBeGreaterThan(0);
    }
  });

  it("passes validateSessionGraph", () => {
    for (const playbook of all()) {
      expect(validateSessionGraph(sessionSpecFor(playbook, "goal")), playbook.id).toEqual([]);
    }
  });

  it("references only prompt ids and team names that exist", () => {
    for (const playbook of all()) {
      for (const stage of playbook.stages) {
        if (stage.team !== undefined) {
          expect(playbook.teams, `${playbook.id}/${stage.id}`).toHaveProperty([stage.team]);
        }
      }
      for (const [name, team] of Object.entries(playbook.teams)) {
        expect(team.seats.length, `${playbook.id}/${name}`).toBeGreaterThan(0);
        for (const seat of team.seats) {
          expect(prompts.has(seat.role), `${playbook.id}/${name}: ${seat.role}`).toBe(true);
          expect(seat.provider, `${playbook.id}/${name}`).toBe("AUTO");
        }
      }
    }
  });

  it("enforces the read-only rule: no execute stage, only read-only seats", () => {
    for (const playbook of all()) {
      const readOnly = READ_ONLY_IDS.includes(playbook.id);
      expect(playbook.readOnly, playbook.id).toBe(readOnly);
      if (!readOnly) continue;
      expect(playbook.stages.some((stage) => stage.kind === "execute"), playbook.id).toBe(false);
      for (const team of Object.values(playbook.teams)) {
        for (const seat of team.seats) {
          expect(seat.permissions, playbook.id).toBe("read-only");
        }
      }
    }
  });

  it("waits for approval before every execute stage", () => {
    for (const playbook of all()) {
      for (const stage of playbook.stages.filter((s) => s.kind === "execute")) {
        expect(stage.requireApproval, `${playbook.id}/${stage.id}`).toBe(true);
      }
    }
  });

  it("feature-build is plan (debate) → execute (best-of-n, 2) → review (panel, security-veto)", () => {
    const stages = library.get("feature-build")!.stages;
    expect(stages.map((stage) => [stage.id, stage.kind, stage.strategy])).toEqual([
      ["plan", "plan", "debate"],
      ["build", "execute", "best-of-n"],
      ["review", "review", "panel"],
    ]);
    expect(stages[1]!.options).toEqual({ n: 2 });
    expect(stages[2]!.options).toMatchObject({ policy: "security-veto" });
  });

  it("passes the stage runner's own checks once AUTO seats are bound to mock", () => {
    for (const playbook of all()) {
      const seatsFor = (stage: StageSpec) => {
        const team = stage.team === undefined ? undefined : playbook.teams[stage.team];
        if (!team) throw new Error(`no team for stage ${stage.id}`);
        return expandSeatSpecs(team.seats.map((seat) => ({ ...seat, provider: "mock" as const })));
      };
      const runners = createStageRunners({
        projectPath: root,
        scheduler: {} as SeatScheduler,
        runStep: async () => undefined,
        seatsFor,
        createExecutor: () => {
          throw new Error("not used by validate");
        },
        createReviewer: () => {
          throw new Error("not used by validate");
        },
      });
      const spec = sessionSpecFor(playbook, "goal");
      for (const stage of spec.stages) {
        expect(runners.validate?.(stage, spec), `${playbook.id}/${stage.id}`).toBeUndefined();
      }
    }
  });
});
