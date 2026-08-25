import { describe, expect, it } from "vitest";
import {
  createProtocolMessage,
  EvidenceKind,
  extractJsonCandidate,
  MessageType,
  parseProtocolMessage,
  peekMessageType,
} from "../../src/index.js";

const baseEnvelope = {
  messageId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  round: 1,
  from: "reviewer",
  to: "executor",
  requiresResponse: true,
  timestamp: "2026-08-25T12:00:00.000Z",
};

describe("protocol messages", () => {
  it("parses a valid EVIDENCE_REQUEST", () => {
    const result = parseProtocolMessage({
      ...baseEnvelope,
      type: MessageType.EvidenceRequest,
      content: {
        reason: "Need implementation details",
        requests: [
          { kind: EvidenceKind.File, path: "src/avg.ts" },
          { kind: EvidenceKind.Command, command: "npm test" },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data.type === MessageType.EvidenceRequest) {
      expect(result.data.content.requests).toHaveLength(2);
    }
  });

  it("creates typed messages with defaults", () => {
    const message = createProtocolMessage({
      conversationId: baseEnvelope.conversationId,
      round: 2,
      from: "supervisor",
      to: "executor",
      type: MessageType.Task,
      content: { goal: "Implement average()" },
    });

    expect(message.type).toBe(MessageType.Task);
    expect(message.requiresResponse).toBe(true);
    expect(message.messageId.length).toBeGreaterThan(0);
    expect(message.timestamp).toMatch(/Z$/);
  });

  it("rejects unknown message types without throwing", () => {
    const result = parseProtocolMessage({
      ...baseEnvelope,
      type: "NOT_A_REAL_TYPE",
      content: { summary: "x" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid protocol message");
    }
  });

  it("rejects wrong payload for a known type without throwing", () => {
    const result = parseProtocolMessage({
      ...baseEnvelope,
      type: MessageType.Question,
      content: { answer: "missing question field" },
    });

    expect(result.ok).toBe(false);
  });

  it("extracts JSON from fenced agent prose", () => {
    const raw = `
I need more evidence.

\`\`\`json
${JSON.stringify({
  ...baseEnvelope,
  type: MessageType.Blocked,
  requiresResponse: false,
  content: { reason: "Ambiguous requirements" },
})}
\`\`\`
`;

    const extracted = extractJsonCandidate(raw);
    expect(extracted.ok).toBe(true);

    const parsed = parseProtocolMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.type).toBe(MessageType.Blocked);
    }
  });

  it("handles completely malformed output safely", () => {
    expect(parseProtocolMessage("not json at all").ok).toBe(false);
    expect(parseProtocolMessage("").ok).toBe(false);
    expect(parseProtocolMessage(42).ok).toBe(false);
    expect(parseProtocolMessage(null).ok).toBe(false);
  });

  it("peeks message type from partial payloads", () => {
    expect(
      peekMessageType({ type: MessageType.ChangeRequest, content: {} }),
    ).toBe(MessageType.ChangeRequest);
    expect(peekMessageType({ type: "NOPE" })).toBeUndefined();
    expect(peekMessageType("garbage")).toBeUndefined();
  });
});
