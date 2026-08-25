import { describe, expect, it } from "vitest";
import {
  createConversationId,
  createId,
  createMessageId,
  createTaskId,
  isId,
} from "../../src/core/ids.js";

describe("ids", () => {
  it("generates unique UUID v4 ids", () => {
    const a = createId();
    const b = createId();
    expect(a).not.toBe(b);
    expect(isId(a)).toBe(true);
    expect(isId(b)).toBe(true);
  });

  it("exposes typed id helpers that are valid ids", () => {
    expect(isId(createTaskId())).toBe(true);
    expect(isId(createMessageId())).toBe(true);
    expect(isId(createConversationId())).toBe(true);
  });

  it("rejects non-uuid strings", () => {
    expect(isId("")).toBe(false);
    expect(isId("not-a-uuid")).toBe(false);
    expect(isId("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
