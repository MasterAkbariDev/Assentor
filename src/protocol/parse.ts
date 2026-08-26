import { z } from "zod";
import { createMessageId } from "../core/ids.js";
import {
  MessagePayloadByType,
  MessageType,
  MessageTypeSchema,
  ProtocolMessageSchema,
  type ProtocolMessage,
} from "./messages.js";
import {
  ReviewResultSchema,
  type ReviewResult,
  type ReviewResultParsed,
} from "./review-result.js";

export type ParseSuccess<T> = {
  ok: true;
  data: T;
};

export type ParseFailure = {
  ok: false;
  error: string;
  details?: unknown;
  raw?: unknown;
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Extracts a JSON object from raw agent output.
 * Accepts a bare object or a fenced ```json block.
 * Never throws.
 */
export function extractJsonCandidate(raw: unknown): ParseResult<unknown> {
  if (raw !== null && typeof raw === "object") {
    return { ok: true, data: raw };
  }

  if (typeof raw !== "string") {
    return {
      ok: false,
      error: "Expected string or object agent output",
      raw,
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty agent output", raw };
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  // Prefer the first {...} object if surrounding prose exists.
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonText = objectMatch?.[0] ?? candidate;

  try {
    return { ok: true, data: JSON.parse(jsonText) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to parse JSON from agent output",
      details: error instanceof Error ? error.message : error,
      raw,
    };
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseProtocolMessage(
  input: unknown,
): ParseResult<ProtocolMessage> {
  const extracted = extractJsonCandidate(input);
  if (!extracted.ok) {
    return extracted;
  }

  const result = ProtocolMessageSchema.safeParse(extracted.data);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid protocol message: ${formatZodError(result.error)}`,
      details: result.error.flatten(),
      raw: extracted.data,
    };
  }

  return { ok: true, data: result.data };
}

export function parseReviewResult(input: unknown): ParseResult<ReviewResultParsed> {
  const extracted = extractJsonCandidate(input);
  if (!extracted.ok) {
    return extracted;
  }

  const normalized = normalizeReviewCandidate(extracted.data);
  const result = ReviewResultSchema.safeParse(normalized);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid review result: ${formatZodError(result.error)}`,
      details: result.error.flatten(),
      raw: extracted.data,
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Models often emit confidence as 0–100 or slightly over 1.
 * Coerce to the Assentor 0–1 scale before schema validation.
 */
export function normalizeReviewConfidence(value: unknown): number | unknown {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/%$/, "");
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) {
      return value;
    }
    value = asNumber;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }

  let confidence = value;
  // Clear percentage style (e.g. 85, 92.5) — not tiny overshoots like 1.05
  if (confidence >= 2 && confidence <= 100) {
    confidence = confidence / 100;
  }
  if (confidence > 1) {
    confidence = 1;
  }
  if (confidence < 0) {
    confidence = 0;
  }
  return confidence;
}

function coerceStringList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return item.trim() ? [item] : [];
      }
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const text = [rec.description, rec.path, rec.text, rec.evidence]
          .find((part) => typeof part === "string" && part.trim());
        return typeof text === "string" ? [text] : [];
      }
      if (item == null) {
        return [];
      }
      return [String(item)];
    });
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [String(value)];
}

function wrapAsArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeIssue(issue: unknown, index: number): unknown {
  if (typeof issue === "string") {
    const trimmed = issue.trim();
    return {
      id: `ISSUE-${index + 1}`,
      severity: "minor",
      description: trimmed || `Issue ${index + 1}`,
      evidence: [],
      affectedFiles: [],
    };
  }
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    return issue;
  }
  const rec = { ...(issue as Record<string, unknown>) };
  if (typeof rec.id !== "string" || !rec.id.trim()) {
    rec.id = `ISSUE-${index + 1}`;
  }
  if (typeof rec.severity === "string") {
    rec.severity = rec.severity.toLowerCase();
  } else if (rec.severity == null) {
    rec.severity = "minor";
  }
  rec.evidence = coerceStringList(rec.evidence);
  rec.affectedFiles = coerceStringList(rec.affectedFiles);
  if (typeof rec.description !== "string" || !rec.description.trim()) {
    rec.description =
      (typeof rec.summary === "string" && rec.summary.trim()) || rec.id;
  }
  return rec;
}

function normalizeReviewCandidate(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  const record = { ...(data as Record<string, unknown>) };
  if ("confidence" in record) {
    record.confidence = normalizeReviewConfidence(record.confidence);
  }
  if ("requiredChanges" in record) {
    record.requiredChanges = coerceStringList(record.requiredChanges);
  }
  if ("optionalChanges" in record) {
    record.optionalChanges = coerceStringList(record.optionalChanges);
  }
  if ("issues" in record) {
    record.issues = wrapAsArray(record.issues).map((issue, index) =>
      normalizeIssue(issue, index),
    );
  }
  if ("evidenceRequests" in record && !Array.isArray(record.evidenceRequests)) {
    record.evidenceRequests = wrapAsArray(record.evidenceRequests);
  }
  return record;
}

export interface CreateMessageInput<T extends ProtocolMessage["type"]> {
  conversationId: string;
  round: number;
  from: string;
  to: string;
  type: T;
  content: z.input<(typeof MessagePayloadByType)[T]>;
  requiresResponse?: boolean;
  messageId?: string;
  timestamp?: string;
}

/**
 * Builds a validated protocol message. Throws only on programmer error
 * (invalid construction), not on agent output.
 */
export function createProtocolMessage<T extends ProtocolMessage["type"]>(
  input: CreateMessageInput<T>,
): Extract<ProtocolMessage, { type: T }> {
  const message = {
    messageId: input.messageId ?? createMessageId(),
    conversationId: input.conversationId,
    round: input.round,
    from: input.from,
    to: input.to,
    type: input.type,
    content: input.content,
    requiresResponse: input.requiresResponse ?? defaultRequiresResponse(input.type),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  const parsed = ProtocolMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error(
      `Failed to create protocol message: ${formatZodError(parsed.error)}`,
    );
  }

  return parsed.data as Extract<ProtocolMessage, { type: T }>;
}

function defaultRequiresResponse(type: MessageType): boolean {
  switch (type) {
    case MessageType.Question:
    case MessageType.EvidenceRequest:
    case MessageType.ChangeRequest:
    case MessageType.InvestigationRequest:
    case MessageType.TestRequest:
    case MessageType.BuildRequest:
    case MessageType.ClarificationRequest:
    case MessageType.Task:
      return true;
    default:
      return false;
  }
}

/**
 * Best-effort recovery: if the payload has a recognizable type field,
 * return that type even when the full message is invalid.
 */
export function peekMessageType(input: unknown): MessageType | undefined {
  const extracted = extractJsonCandidate(input);
  if (!extracted.ok || extracted.data === null || typeof extracted.data !== "object") {
    return undefined;
  }

  const type = (extracted.data as { type?: unknown }).type;
  const parsed = MessageTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : undefined;
}
