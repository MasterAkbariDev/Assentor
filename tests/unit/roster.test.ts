import { describe, expect, it } from "vitest";
import { SEAT_PROVIDERS, type SeatProvider } from "../../src/core/seats.js";
import { DEFAULT_CAPABILITIES, mergeCapabilities } from "../../src/modes/capabilities.js";
import {
  CapabilityProfileSchema,
  type CapabilityProfile,
  type ProviderAvailability,
  type RosterPolicy,
} from "../../src/modes/roster.js";
import {
  buildRoster,
  formatRosterForPrompt,
  type RosterCatalogItem,
} from "../../src/modes/roster-build.js";

function item(provider: SeatProvider, id: string, label = id): RosterCatalogItem {
  return { provider, id, label };
}

function avail(
  provider: SeatProvider,
  model: string,
  extra: Partial<ProviderAvailability> = {},
): ProviderAvailability {
  return { provider, model, installed: true, authenticated: true, freeSlots: 1, ...extra };
}

function profile(
  key: string,
  extra: Partial<Omit<CapabilityProfile, "key">> = {},
): CapabilityProfile {
  return { key, strengths: [], speed: "medium", cost: "medium", ...extra };
}

const NO_POLICY: RosterPolicy = {};

describe("DEFAULT_CAPABILITIES", () => {
  it("are valid profiles with unique keys and only the seeded keys", () => {
    for (const profileEntry of DEFAULT_CAPABILITIES) {
      expect(CapabilityProfileSchema.safeParse(profileEntry).success).toBe(true);
    }
    const keys = DEFAULT_CAPABILITIES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "claude-code/opus",
      "claude-code/sonnet",
      "claude-code/haiku",
      "codex/*",
      "gemini/*",
      "antigravity/*",
      "cursor/*",
      "mock/*",
    ]);
  });
});

describe("mergeCapabilities", () => {
  it("replaces defaults with the same key and appends new keys without mutating inputs", () => {
    const defaults = [profile("codex/*", { speed: "medium" }), profile("mock/*", { speed: "fast" })];
    const overrides = [profile("codex/*", { speed: "slow", cost: "high" }), profile("cursor/*")];
    const before = JSON.stringify(defaults);

    const merged = mergeCapabilities(defaults, overrides);

    expect(merged.map((p) => p.key)).toEqual(["codex/*", "mock/*", "cursor/*"]);
    expect(merged[0]).toEqual(profile("codex/*", { speed: "slow", cost: "high" }));
    expect(JSON.stringify(defaults)).toBe(before);
  });
});

describe("buildRoster filtering", () => {
  const catalog = [
    item("claude-code", "opus"),
    item("claude-code", "sonnet"),
    item("codex", "gpt-5"),
    item("cursor", "auto-model"),
  ];

  it("keeps only installed and authenticated models", () => {
    const roster = buildRoster({
      catalog,
      availability: [
        avail("claude-code", "opus"),
        avail("claude-code", "sonnet", { installed: false }),
        avail("codex", "gpt-5", { authenticated: false }),
        // cursor/auto-model has no availability record at all
      ],
      capabilities: [],
      policy: NO_POLICY,
    });
    expect(roster.map((e) => `${e.provider}/${e.model}`)).toEqual(["claude-code/opus"]);
  });

  it("applies allowedProviders", () => {
    const roster = buildRoster({
      catalog,
      availability: [avail("claude-code", "opus"), avail("codex", "gpt-5")],
      capabilities: [],
      policy: { allowedProviders: ["codex"] },
    });
    expect(roster.map((e) => `${e.provider}/${e.model}`)).toEqual(["codex/gpt-5"]);
  });

  it("applies maxCost against the capability cost tier", () => {
    const capabilities = [
      profile("claude-code/opus", { cost: "high" }),
      profile("claude-code/sonnet", { cost: "medium" }),
      profile("codex/*", { cost: "low" }),
    ];
    const roster = buildRoster({
      catalog: [item("claude-code", "opus"), item("claude-code", "sonnet"), item("codex", "gpt-5")],
      availability: [avail("claude-code", "opus"), avail("claude-code", "sonnet"), avail("codex", "gpt-5")],
      capabilities,
      policy: { maxCost: "medium" },
    });
    expect(roster.map((e) => `${e.provider}/${e.model}`)).toEqual(["codex/gpt-5", "claude-code/sonnet"]);
  });

  it("emits one entry per provider/model even when the catalog repeats it", () => {
    const roster = buildRoster({
      catalog: [item("codex", "gpt-5", "GPT-5"), item("codex", "gpt-5", "again")],
      availability: [avail("codex", "gpt-5")],
      capabilities: [],
      policy: NO_POLICY,
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]?.label).toBe("GPT-5");
  });
});

describe("buildRoster capability lookup", () => {
  it("prefers exact provider/model, then provider/*, then the neutral fallback", () => {
    const capabilities = [
      profile("claude-code/opus", { strengths: ["reasoning"], speed: "slow", cost: "high" }),
      profile("claude-code/*", { strengths: ["docs"], speed: "fast", cost: "low" }),
    ];
    const roster = buildRoster({
      catalog: [item("claude-code", "opus"), item("claude-code", "sonnet"), item("gemini", "pro")],
      availability: [avail("claude-code", "opus"), avail("claude-code", "sonnet"), avail("gemini", "pro")],
      capabilities,
      policy: NO_POLICY,
    });
    const byKey = Object.fromEntries(roster.map((e) => [`${e.provider}/${e.model}`, e]));

    expect(byKey["claude-code/opus"]).toMatchObject({
      strengths: ["reasoning"],
      speed: "slow",
      cost: "high",
    });
    expect(byKey["claude-code/sonnet"]).toMatchObject({ strengths: ["docs"], speed: "fast", cost: "low" });
    expect(byKey["gemini/pro"]).toMatchObject({ strengths: [], speed: "medium", cost: "medium" });
  });
});

describe("buildRoster availability and scoreboard attachments", () => {
  it("attaches freeSlots, rateLimitedUntil and stats only when present", () => {
    const roster = buildRoster({
      catalog: [item("claude-code", "opus"), item("codex", "gpt-5")],
      availability: [
        avail("claude-code", "opus", { freeSlots: 2, rateLimitedUntil: "2026-10-29T12:00:00.000Z" }),
        avail("codex", "gpt-5", { freeSlots: 0 }),
      ],
      capabilities: [],
      scoreboard: { "claude-code/opus": { samples: 4, acceptanceRate: 0.75, reviewPassRate: 0.5 } },
      policy: NO_POLICY,
    });
    const opus = roster.find((e) => e.model === "opus");
    const gpt = roster.find((e) => e.model === "gpt-5");

    expect(opus).toMatchObject({
      freeSlots: 2,
      rateLimitedUntil: "2026-10-29T12:00:00.000Z",
      stats: { samples: 4, acceptanceRate: 0.75, reviewPassRate: 0.5 },
    });
    expect(gpt).toBeDefined();
    expect(gpt).not.toHaveProperty("rateLimitedUntil");
    expect(gpt).not.toHaveProperty("stats");
    expect(gpt?.freeSlots).toBe(0);
  });
});

describe("buildRoster sort order", () => {
  it("sorts free slots desc, cost asc, then provider/model asc, regardless of input order", () => {
    const capabilities = [
      profile("claude-code/opus", { cost: "high" }),
      profile("claude-code/haiku", { cost: "low" }),
      profile("codex/*", { cost: "low" }),
      profile("gemini/*", { cost: "medium" }),
    ];
    const catalog = [
      item("gemini", "pro"),
      item("claude-code", "opus"),
      item("codex", "gpt-5"),
      item("claude-code", "haiku"),
      item("codex", "o3"),
    ];
    const availability = [
      avail("gemini", "pro", { freeSlots: 2 }),
      avail("claude-code", "opus", { freeSlots: 2 }),
      avail("codex", "gpt-5", { freeSlots: 1 }),
      avail("claude-code", "haiku", { freeSlots: 1 }),
      avail("codex", "o3", { freeSlots: 1 }),
    ];

    const expected = [
      "gemini/pro",
      "claude-code/opus",
      "claude-code/haiku",
      "codex/gpt-5",
      "codex/o3",
    ];
    const roster = buildRoster({ catalog, availability, capabilities, policy: NO_POLICY });
    expect(roster.map((e) => `${e.provider}/${e.model}`)).toEqual(expected);

    const reversed = buildRoster({
      catalog: [...catalog].reverse(),
      availability: [...availability].reverse(),
      capabilities,
      policy: NO_POLICY,
    });
    expect(reversed.map((e) => `${e.provider}/${e.model}`)).toEqual(expected);
  });
});

describe("formatRosterForPrompt", () => {
  const roster = buildRoster({
    catalog: [item("claude-code", "opus"), item("codex", "gpt-5"), item("mock", "m1")],
    availability: [avail("claude-code", "opus", { freeSlots: 2 }), avail("codex", "gpt-5"), avail("mock", "m1")],
    capabilities: [profile("claude-code/opus", { strengths: ["coding", "review"], speed: "slow", cost: "high" })],
    scoreboard: { "claude-code/opus": { samples: 3, acceptanceRate: 0.666 } },
    policy: NO_POLICY,
  });

  it("renders a markdown table with the expected columns", () => {
    const text = formatRosterForPrompt(roster);
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "| provider/model | strengths | speed | cost | free slots | acceptance rate |",
    );
    expect(lines[1]).toBe("|---|---|---|---|---|---|");
    expect(lines[2]).toBe("| claude-code/opus | coding, review | slow | high | 2 | 67% |");
    expect(lines[3]).toBe("| codex/gpt-5 | - | medium | medium | 1 | - |");
    expect(lines).toHaveLength(5);
  });

  it("truncates with a final '… N more' row", () => {
    const text = formatRosterForPrompt(roster, { maxRows: 1 });
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^\| claude-code\/opus \|/);
    expect(lines[3]).toBe("| … 2 more | | | | | |");
  });

  it("does not add a truncation row when everything fits", () => {
    expect(formatRosterForPrompt(roster, { maxRows: 3 })).not.toContain("more");
  });
});
