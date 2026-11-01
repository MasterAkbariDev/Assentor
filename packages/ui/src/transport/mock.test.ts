import { describe, expect, it } from "vitest";
import { sessionFixture } from "../test/fixtures.js";
import { runTransportContract } from "./contract.test-suite.js";
import { mockTransport } from "./mock.js";

runTransportContract("mockTransport", async () => {
  const { id, events } = sessionFixture;
  const first = events.slice(0, 4);
  const transport = mockTransport({ sessions: { [id]: first } });
  let next = first.length;
  return {
    transport,
    sessionId: id,
    events: first,
    emit: async () => {
      const event = { ...events[next]!, seq: next + 1 };
      next += 1;
      transport.emit(event);
      return event;
    },
    drop: () => transport.drop(),
    dispose: () => undefined,
  };
});

describe("mockTransport", () => {
  it("records calls and answers from handlers", async () => {
    const t = mockTransport({ handlers: { "sessions.list": () => ({ sessions: [] }) } });
    await t.call("sessions.list");
    expect(t.calls).toEqual([{ method: "sessions.list", params: undefined }]);
    await expect(t.call("events.unsubscribe", { subscriptionId: "x" })).rejects.toThrow(/no handler/);
  });
});
