import { describe, expect, it } from "vitest";
import {
  areAllPhasesComplete,
  buildAutonomousContinuationPrompt,
  buildContinuationPrompt,
  buildNextPhaseDirective,
  createEmptyContract,
  createProtocolMessage,
  downgradePassIfPhasesRemain,
  isStalledWaitingForConfirmation,
  makeReviewResult,
  MessageType,
  ReviewStatus,
} from "../../src/index.js";

describe("phase steering", () => {
  it("detects stall phrases", () => {
    expect(
      isStalledWaitingForConfirmation(
        "Phase 1 is done. Should I proceed to Phase 2?",
      ),
    ).toBe(true);
    expect(
      isStalledWaitingForConfirmation("Implemented the schema and API."),
    ).toBe(false);
  });

  it("builds an imperative next-phase directive", () => {
    const directive = buildNextPhaseDirective("Schema", {
      id: "p2",
      title: "API",
      description: "Implement REST endpoints",
      status: "pending",
      acceptanceCriteria: ["GET /items works"],
    });
    expect(directive).toMatch(/autonomous execution mode/i);
    expect(directive).toMatch(/Do NOT stop/i);
    expect(directive).toContain("API");
    expect(directive).toContain("GET /items works");
  });

  it("downgrades PASS when phases remain", () => {
    const contract = createEmptyContract("Build the app");
    contract.phases = [
      { id: "p1", title: "Schema", status: "completed", acceptanceCriteria: [] },
      { id: "p2", title: "API", status: "pending", acceptanceCriteria: [] },
    ];
    const review = makeReviewResult({
      status: ReviewStatus.Pass,
      confidence: 0.9,
      summary: "Phase 1 looks good",
      phaseProgress: {
        completedPhaseIds: ["p1"],
        allPhasesComplete: false,
      },
    });
    const next = downgradePassIfPhasesRemain(review, contract, false);
    expect(next.status).toBe(ReviewStatus.NeedsWork);
    expect(next.phaseProgress?.nextPhaseDirective).toMatch(/API/);
    expect(areAllPhasesComplete(contract.phases, next.phaseProgress)).toBe(
      false,
    );
  });

  it("wraps continuation prompts with anti-stall framing and the directive", () => {
    const prompt = buildContinuationPrompt(
      [
        createProtocolMessage({
          conversationId: "c",
          round: 2,
          from: "reviewer",
          to: "executor",
          type: MessageType.ChangeRequest,
          content: {
            summary: "Continue",
            requiredChanges: [],
            nextPhaseDirective: "Proceed immediately to Phase 2",
          },
        }),
      ],
      "Proceed immediately to Phase 2: Implement API. Do NOT ask for confirmation.",
      "autopilot",
    );
    expect(prompt).toMatch(/AUTONOMOUS SUPERVISOR DIRECTIVE/);
    expect(prompt).toMatch(/DO NOT pause/i);
    expect(prompt).toContain("Proceed immediately to Phase 2");
    expect(prompt).toContain("ACTIVE DIRECTIVE");
  });

  it("keeps the shared continuation helper equivalent", () => {
    const messages = [
      createProtocolMessage({
        conversationId: "c",
        round: 1,
        from: "reviewer",
        to: "executor",
        type: MessageType.ChangeRequest,
        content: { summary: "Fix types", requiredChanges: ["Fix types"] },
      }),
    ];
    expect(buildAutonomousContinuationPrompt(messages, "keep going")).toContain(
      "keep going",
    );
  });
});
