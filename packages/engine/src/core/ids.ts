import { randomUUID } from "node:crypto";

/**
 * Generates a UUID v4 identifier for tasks, messages, and conversations.
 */
export function createId(): string {
  return randomUUID();
}

export function createTaskId(): string {
  return createId();
}

export function createMessageId(): string {
  return createId();
}

export function createConversationId(): string {
  return createId();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isId(value: string): boolean {
  return UUID_RE.test(value);
}
