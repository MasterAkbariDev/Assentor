import { promises as fs } from "node:fs";
import path from "node:path";
import { ASSENTOR_DIR } from "../persistence/paths.js";
import type { RoutingPreference } from "../models/registry.js";

export type AgentKind = "executor" | "reviewer" | "adjudicator";

export type ReviewerSpecialty =
  | "architecture"
  | "code"
  | "testing"
  | "security"
  | "performance"
  | "ui"
  | "general"
  | "adjudicator";

export type ReviewerTransport = "api" | "cli";

export interface ReviewerFallbackConfig {
  transport?: ReviewerTransport;
  provider?: string;
  model?: string;
}

export interface LogicalAgentProfile {
  id: string;
  name: string;
  kind: AgentKind;
  specialty?: ReviewerSpecialty;
  role: string;
  instructions: string;
  provider: string | "AUTO";
  model: string | "AUTO";
  routing: RoutingPreference;
  enabled: boolean;
  /** Executor adapter id when kind=executor */
  executorId?: string;
  /**
   * How this logical reviewer is reached. Identity (id/name/memory) is
   * independent of transport — CLI vs API can swap without losing context.
   */
  transport?: ReviewerTransport;
  /** Optional fallback transport/provider/model if primary fails. */
  fallback?: ReviewerFallbackConfig;
}

export interface AgentMemory {
  agentId: string;
  taskSummary?: string;
  findings: string[];
  unresolvedIssues: string[];
  decisions: string[];
  evidenceRefs: string[];
  rollingSummary: string;
  recentMessages: Array<{ role: string; content: string; at: string }>;
  updatedAt: string;
}

export const DEFAULT_AGENT_PROFILES: LogicalAgentProfile[] = [
  {
    id: "main-executor",
    name: "Main Executor",
    kind: "executor",
    role: "Implement the task by editing the project",
    instructions: "Follow the task contract. Prefer minimal correct changes.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
    executorId: "cursor",
  },
  {
    id: "architecture-reviewer",
    name: "Architecture Reviewer",
    kind: "reviewer",
    specialty: "architecture",
    role: "Review architecture and module boundaries",
    instructions:
      "Focus on structure, coupling, and design consistency. Cite interfaces, callers, and unchanged boundaries — no vague architecture opinions.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BEST",
    enabled: true,
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    kind: "reviewer",
    specialty: "code",
    role: "Review code quality and correctness",
    instructions:
      "Focus on bugs, readability, and maintainability. Every issue must cite file/diff evidence from the pack.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
  },
  {
    id: "testing-reviewer",
    name: "Testing Reviewer",
    kind: "reviewer",
    specialty: "testing",
    role: "Review test coverage and verification",
    instructions:
      "Ensure acceptance criteria are verifiable with tests/evidence. Do not PASS when required verification is NOT_RUN.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
  },
  {
    id: "security-reviewer",
    name: "Security Reviewer",
    kind: "reviewer",
    specialty: "security",
    role: "Review security posture",
    instructions:
      "Look for auth, injection, secret leakage, and unsafe defaults. Blocker/major security findings must cite concrete evidence.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BEST",
    enabled: true,
  },
  {
    id: "performance-reviewer",
    name: "Performance Reviewer",
    kind: "reviewer",
    specialty: "performance",
    role: "Review performance risks",
    instructions:
      "Flag hotspots, N+1 patterns, and unbounded work with call-site evidence — never invent benchmarks.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
  },
  {
    id: "ui-reviewer",
    name: "UI Reviewer",
    kind: "reviewer",
    specialty: "ui",
    role: "Review UI/UX quality",
    instructions:
      "Check accessibility, layout, and interaction clarity. Cite component paths; request screenshots when visuals are unverifiable.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
  },
  {
    id: "general-reviewer",
    name: "General Reviewer",
    kind: "reviewer",
    specialty: "general",
    role: "General quality gate",
    instructions:
      "Evaluate overall acceptance criteria satisfaction against the evidence pack — verify executor claims.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BALANCED",
    enabled: true,
  },
  {
    id: "adjudicator",
    name: "Adjudicator",
    kind: "adjudicator",
    specialty: "adjudicator",
    role: "Resolve reviewer disagreements without editing the project",
    instructions:
      "Decide PASS, NEEDS_WORK, MORE_EVIDENCE, or BLOCKED based on evidence and arguments. Security blockers may veto majority PASS.",
    provider: "AUTO",
    model: "AUTO",
    routing: "BEST",
    enabled: true,
  },
];

export class AgentRegistry {
  private profiles: LogicalAgentProfile[] = [];
  private readonly filePath: string;

  constructor(projectPath: string) {
    this.filePath = path.join(
      path.resolve(projectPath),
      ASSENTOR_DIR,
      "agents.json",
    );
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.profiles = JSON.parse(raw) as LogicalAgentProfile[];
    } catch {
      this.profiles = structuredClone(DEFAULT_AGENT_PROFILES);
      await this.save();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      `${JSON.stringify(this.profiles, null, 2)}\n`,
      "utf8",
    );
  }

  list(): LogicalAgentProfile[] {
    return [...this.profiles];
  }

  get(id: string): LogicalAgentProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  async upsert(profile: LogicalAgentProfile): Promise<void> {
    const idx = this.profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      this.profiles[idx] = profile;
    } else {
      this.profiles.push(profile);
    }
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.save();
    return this.profiles.length < before;
  }
}

export class AgentMemoryStore {
  constructor(private readonly projectPath: string) {}

  private memoryPath(agentId: string): string {
    return path.join(
      path.resolve(this.projectPath),
      ASSENTOR_DIR,
      "agents",
      agentId,
      "memory.json",
    );
  }

  async load(agentId: string): Promise<AgentMemory> {
    try {
      const raw = await fs.readFile(this.memoryPath(agentId), "utf8");
      return JSON.parse(raw) as AgentMemory;
    } catch {
      return emptyMemory(agentId);
    }
  }

  async save(memory: AgentMemory): Promise<void> {
    const file = this.memoryPath(memory.agentId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    memory.updatedAt = new Date().toISOString();
    await fs.writeFile(file, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  }

  async appendMessage(
    agentId: string,
    role: string,
    content: string,
  ): Promise<AgentMemory> {
    const memory = await this.load(agentId);
    memory.recentMessages.push({
      role,
      content,
      at: new Date().toISOString(),
    });
    if (memory.recentMessages.length > 40) {
      const dropped = memory.recentMessages.splice(
        0,
        memory.recentMessages.length - 20,
      );
      memory.rollingSummary = compressMessages(
        memory.rollingSummary,
        dropped,
      );
    }
    await this.save(memory);
    return memory;
  }

  /**
   * Build context for a logical agent — survives provider/model/key changes.
   */
  buildContextPack(input: {
    memory: AgentMemory;
    contractGoal: string;
    acceptanceCriteria: string[];
    evidence?: string[];
  }): string {
    return [
      `Task: ${input.contractGoal}`,
      `Acceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "- (none)"}`,
      `Rolling summary:\n${input.memory.rollingSummary || "(none)"}`,
      `Unresolved issues:\n${input.memory.unresolvedIssues.map((i) => `- ${i}`).join("\n") || "- (none)"}`,
      `Findings:\n${input.memory.findings.map((f) => `- ${f}`).join("\n") || "- (none)"}`,
      `Decisions:\n${input.memory.decisions.map((d) => `- ${d}`).join("\n") || "- (none)"}`,
      `Recent messages:\n${input.memory.recentMessages
        .slice(-10)
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n") || "(none)"}`,
      `Evidence:\n${(input.evidence ?? []).slice(0, 5).join("\n---\n") || "(none)"}`,
    ].join("\n\n");
  }
}

function emptyMemory(agentId: string): AgentMemory {
  return {
    agentId,
    findings: [],
    unresolvedIssues: [],
    decisions: [],
    evidenceRefs: [],
    rollingSummary: "",
    recentMessages: [],
    updatedAt: new Date().toISOString(),
  };
}

function compressMessages(
  previous: string,
  dropped: Array<{ role: string; content: string }>,
): string {
  const digest = dropped
    .map((m) => `${m.role}: ${m.content.slice(0, 120)}`)
    .join(" | ");
  const next = `${previous ? `${previous}\n` : ""}[summarized] ${digest}`.trim();
  return next.slice(-4000);
}

export {
  RoutedReviewer,
  adjudicate,
  reviewersDisagree,
  type ReviewerFinding,
  type AdjudicatorDecision,
} from "./routed-reviewer.js";

export type ReviewStrategy = "SINGLE" | "ADAPTIVE" | "PANEL" | "FULL";

export function selectReviewers(
  profiles: LogicalAgentProfile[],
  strategy: ReviewStrategy,
  taskText: string,
  limits: { min: number; max: number },
  analysis?: {
    recommendedCount?: number;
    recommendedRoles?: ReviewerSpecialty[];
  },
): LogicalAgentProfile[] {
  const reviewers = profiles.filter(
    (p) => p.kind === "reviewer" && p.enabled && p.specialty !== "adjudicator",
  );
  const specialties =
    analysis?.recommendedRoles && analysis.recommendedRoles.length > 0
      ? analysis.recommendedRoles
      : inferSpecialties(taskText);

  let selected: LogicalAgentProfile[] = [];
  if (strategy === "FULL") {
    selected = reviewers;
  } else if (strategy === "SINGLE") {
    selected = [
      reviewers.find((r) => r.specialty === "general") ?? reviewers[0],
    ].filter(Boolean) as LogicalAgentProfile[];
  } else if (strategy === "PANEL") {
    selected = reviewers.filter((r) =>
      specialties.includes(r.specialty as ReviewerSpecialty),
    );
    if (selected.length < 3) {
      selected = reviewers.slice(0, Math.min(3, reviewers.length));
    }
  } else {
    // ADAPTIVE
    const count =
      analysis?.recommendedCount ??
      (() => {
        const complexity = estimateComplexity(taskText);
        return complexity === "simple"
          ? 1
          : complexity === "medium"
            ? 2
            : complexity === "hard"
              ? 4
              : 6;
      })();
    const preferred = reviewers.filter((r) =>
      specialties.includes(r.specialty as ReviewerSpecialty),
    );
    selected = uniqueProfiles([
      ...preferred,
      ...reviewers,
    ]).slice(0, Math.max(limits.min, Math.min(limits.max, count)));
  }

  return uniqueProfiles(selected).slice(
    0,
    Math.max(limits.min, Math.min(limits.max, selected.length || limits.min)),
  );
}

function inferSpecialties(taskText: string): ReviewerSpecialty[] {
  const t = taskText.toLowerCase();
  const out: ReviewerSpecialty[] = ["general"];
  if (/auth|login|password|token|oauth|jwt|security/.test(t)) {
    out.push("security", "architecture", "testing");
  }
  if (/database|migration|sql|schema|prisma/.test(t)) {
    out.push("architecture", "testing");
  }
  if (/ui|css|html|react|svelte|accessibility|a11y/.test(t)) {
    out.push("ui", "code");
  }
  if (/refactor|architecture|module/.test(t)) {
    out.push("architecture", "code", "testing", "performance");
  }
  if (/perf|latency|optim|cache/.test(t)) {
    out.push("performance", "architecture", "code");
  }
  return [...new Set(out)];
}

function estimateComplexity(taskText: string): "simple" | "medium" | "hard" | "very_hard" {
  const len = taskText.length;
  const signals = (
    taskText.match(/auth|security|migration|refactor|performance|distributed/gi) ??
    []
  ).length;
  if (len < 80 && signals === 0) return "simple";
  if (len < 200 && signals <= 1) return "medium";
  if (signals >= 3 || len > 500) return "very_hard";
  return "hard";
}

function uniqueProfiles(
  profiles: LogicalAgentProfile[],
): LogicalAgentProfile[] {
  const seen = new Set<string>();
  const out: LogicalAgentProfile[] = [];
  for (const p of profiles) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
