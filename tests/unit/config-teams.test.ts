import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseAssentorConfig } from "../../packages/engine/src/config/schema.js";
import { mergeConfigLayers } from "../../packages/engine/src/config/load.js";
import { resolveTeams } from "../../packages/engine/src/config/teams.js";
import { expandSeatSpecs } from "../../packages/protocol/src/seats.js";

describe("config teams and modes", () => {
  it("default config shape is unchanged apart from teams and modes", () => {
    const config = parseAssentorConfig({});
    expect(config.teams).toEqual({});
    expect(config.modes).toEqual({});
    expect(Object.keys(config)).toEqual([
      "project",
      "executor",
      "output",
      "run",
      "reviewers",
      "teams",
      "modes",
      "routing",
      "models",
      "limits",
      "binaries",
      "git",
      "security",
      "artifacts",
      "skills",
      "worktrees",
      "verification",
    ]);
  });

  it("maps legacy reviewers to a read-only review team", () => {
    const config = parseAssentorConfig({
      reviewers: [
        { provider: "mock", transport: "api", model: "m1" },
        { provider: "gemini", transport: "api", model: "gemini-x", name: "G" },
      ],
    });
    const { review } = resolveTeams(config);
    expect(review.seats).toEqual([
      {
        provider: "mock",
        transport: "api",
        model: "m1",
        role: "general",
        count: 1,
        permissions: "read-only",
      },
      {
        provider: "gemini",
        transport: "api",
        model: "gemini-x",
        role: "general",
        name: "G",
        count: 1,
        permissions: "read-only",
      },
    ]);
    expect(
      expandSeatSpecs(review.seats).map((s) => [s.provider, s.transport, s.model]),
    ).toEqual([
      ["mock", "api", "m1"],
      ["gemini", "api", "gemini-x"],
    ]);
  });

  it("maps the legacy default reviewer and executor", () => {
    const { executor, review } = resolveTeams(parseAssentorConfig({}));
    expect(executor.seats).toEqual([
      {
        provider: "mock",
        model: "AUTO",
        role: "engineer",
        count: 1,
        permissions: "edit",
      },
    ]);
    expect(review.seats).toHaveLength(1);
    expect(review.seats[0]).toMatchObject({ provider: "mock", permissions: "read-only" });
  });

  it("uses the team named by modes.review", () => {
    const config = parseAssentorConfig({
      reviewers: [{ provider: "openai", transport: "api" }],
      teams: {
        panel: {
          seats: [
            { provider: "mock", count: 3, permissions: "read-only" },
            { provider: "gemini", transport: "api", role: "code-reviewer" },
          ],
        },
      },
      modes: { review: { team: "panel", policy: "unanimous" } },
    });
    expect(config.modes.review).toEqual({
      team: "panel",
      policy: "unanimous",
      tiebreak: "adjudicator",
    });
    expect(resolveTeams(config).review).toEqual(config.teams.panel);
  });

  it("parses the YAML example from plan §3", () => {
    const yaml = `
teams:
  heavy-negotiators:
    seats:
      - { provider: claude-code, model: opus, count: 3, role: engineer }
      - { provider: codex, model: "<codex model id>", count: 2, role: engineer }
  review-panel:
    seats:
      - { provider: claude-code, model: sonnet, role: security-reviewer }
      - { provider: gemini, transport: api, model: AUTO, role: code-reviewer, count: 2 }
      - { provider: codex, role: test-reviewer }

modes:
  negotiate: { team: heavy-negotiators, strategy: debate, maxRounds: 3, consensus: 0.7 }
  review:    { team: review-panel, strategy: panel, tiebreak: negotiate }
`;
    const config = parseAssentorConfig(parseYaml(yaml));
    expect(Object.keys(config.teams)).toEqual(["heavy-negotiators", "review-panel"]);
    expect(config.modes.negotiate).toEqual({
      team: "heavy-negotiators",
      strategy: "debate",
      maxRounds: 3,
      consensus: 0.7,
    });
    expect(config.modes.review).toEqual({
      team: "review-panel",
      policy: "security-veto",
      tiebreak: "negotiate",
    });
    expect(resolveTeams(config).review).toEqual(config.teams["review-panel"]);
    expect(expandSeatSpecs(config.teams["heavy-negotiators"]!.seats)).toHaveLength(5);
  });

  it("accepts count 1 to 8 and rejects 0 and 9", () => {
    const seat = (count: number) =>
      parseAssentorConfig({
        teams: { t: { seats: [{ provider: "mock", count }] } },
      });
    expect(seat(3).teams.t?.seats[0]?.count).toBe(3);
    expect(() => seat(0)).toThrow();
    expect(() => seat(9)).toThrow();
  });

  it("throws the exact message for an unknown team in modes.review", () => {
    const config = parseAssentorConfig({
      teams: { panel: { seats: [{ provider: "mock" }] } },
      modes: { review: { team: "nope" } },
    });
    expect(() => resolveTeams(config)).toThrow(
      'Unknown team "nope" in modes.review. Defined teams: panel',
    );
  });

  it("reports (none) when no teams are defined", () => {
    const config = parseAssentorConfig({ modes: { negotiate: { team: "x" } } });
    expect(() => resolveTeams(config)).toThrow(
      'Unknown team "x" in modes.negotiate. Defined teams: (none)',
    );
  });

  it("maps a legacy gemini CLI reviewer to the Antigravity CLI seat", () => {
    const config = parseAssentorConfig({
      reviewers: [{ provider: "gemini", transport: "cli", model: "g-1" }],
    });
    const { review } = resolveTeams(config);
    expect(review.seats).toEqual([
      {
        provider: "antigravity",
        transport: "cli",
        model: "g-1",
        role: "general",
        count: 1,
        permissions: "read-only",
      },
    ]);
  });

  it("keeps a legacy gemini API reviewer on the gemini provider", () => {
    const config = parseAssentorConfig({
      reviewers: [{ provider: "gemini", transport: "api" }],
    });
    expect(resolveTeams(config).review.seats[0]).toMatchObject({
      provider: "gemini",
      transport: "api",
    });
  });

  it("names the reviewer and supported transport for an unsupported legacy transport", () => {
    const config = parseAssentorConfig({
      reviewers: [
        { provider: "mock", transport: "api" },
        { provider: "claude", transport: "api" },
      ],
    });
    expect(() => resolveTeams(config)).toThrow(
      'reviewers[1] (claude): transport "api" is not supported; use "cli"',
    );
  });

  it("a project-layer team replaces a user-layer team of the same name wholesale", () => {
    const user = {
      teams: {
        panel: { seats: [{ provider: "mock", count: 2 }] },
        keep: { seats: [{ provider: "openai" }] },
      },
    };
    const project = {
      teams: { panel: { seats: [{ provider: "gemini", transport: "api" }] } },
    };
    const config = parseAssentorConfig(mergeConfigLayers(user, project));
    expect(config.teams.panel).toEqual({
      seats: [
        {
          provider: "gemini",
          transport: "api",
          model: "AUTO",
          role: "general",
          count: 1,
          permissions: "read-only",
        },
      ],
    });
    expect(Object.keys(config.teams)).toEqual(["panel", "keep"]);
  });
});
