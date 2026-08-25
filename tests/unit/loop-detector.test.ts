import { describe, expect, it } from "vitest";
import {
  fingerprintChangeRequest,
  LoopDetector,
} from "../../src/index.js";

describe("loop detector", () => {
  it("fingerprints issue ids and required changes stably", () => {
    const a = fingerprintChangeRequest({
      issueIds: ["B", "A"],
      requiredChanges: [" add tests ", "Fix bug"],
    });
    const b = fingerprintChangeRequest({
      issueIds: ["A", "B"],
      requiredChanges: ["Fix bug", "add tests"],
    });
    expect(a).toBe(b);
  });

  it("detects repeated identical requests", () => {
    const detector = new LoopDetector({ threshold: 3 });

    const first = detector.check(1, {
      requiredChanges: ["Add tests"],
      issueIds: ["TEST-1"],
    });
    const second = detector.check(2, {
      requiredChanges: ["Add tests"],
      issueIds: ["TEST-1"],
    });
    const third = detector.check(3, {
      requiredChanges: ["add tests"],
      issueIds: ["TEST-1"],
    });

    expect(first.looping).toBe(false);
    expect(second.looping).toBe(false);
    expect(third.looping).toBe(true);
    expect(third.signal.count).toBe(3);
    expect(third.signal.rounds).toEqual([1, 2, 3]);
  });

  it("does not treat changing requests as a loop", () => {
    const detector = new LoopDetector({ threshold: 3 });

    expect(
      detector.check(1, { requiredChanges: ["A"] }).looping,
    ).toBe(false);
    expect(
      detector.check(2, { requiredChanges: ["B"] }).looping,
    ).toBe(false);
    expect(
      detector.check(3, { requiredChanges: ["C"] }).looping,
    ).toBe(false);
  });
});
