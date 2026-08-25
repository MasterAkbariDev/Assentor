import { describe, expect, it, vi } from "vitest";
import {
  createProtocolMessage,
  MessageType,
  ProtocolBus,
} from "../../src/index.js";

describe("protocol bus", () => {
  it("routes messages to recipient inboxes", async () => {
    const bus = new ProtocolBus();
    const message = createProtocolMessage({
      conversationId: "c1",
      round: 1,
      from: "reviewer",
      to: "executor",
      type: MessageType.Question,
      content: { question: "Does empty array return 0?" },
    });

    await bus.publish(message);

    expect(bus.pendingCount("executor")).toBe(1);
    expect(bus.pendingCount("reviewer")).toBe(0);

    const received = bus.receive("executor");
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe(message.messageId);
    expect(bus.pendingCount("executor")).toBe(0);
  });

  it("keeps history and supports filters", async () => {
    const bus = new ProtocolBus();

    await bus.publish(
      createProtocolMessage({
        conversationId: "c1",
        round: 1,
        from: "supervisor",
        to: "executor",
        type: MessageType.Task,
        content: { goal: "Ship average()" },
      }),
    );

    await bus.publish(
      createProtocolMessage({
        conversationId: "c1",
        round: 2,
        from: "reviewer",
        to: "executor",
        type: MessageType.ChangeRequest,
        content: {
          summary: "Add tests",
          requiredChanges: ["add tests"],
        },
      }),
    );

    expect(bus.getHistory()).toHaveLength(2);
    expect(bus.getHistory({ round: 2 })).toHaveLength(1);
    expect(bus.getHistory({ type: MessageType.Task })).toHaveLength(1);
    expect(bus.getHistory({ from: "reviewer" })[0]?.type).toBe(
      MessageType.ChangeRequest,
    );
  });

  it("notifies subscribers without crashing the bus", async () => {
    const bus = new ProtocolBus();
    const seen: string[] = [];
    const handler = vi.fn(async (message) => {
      seen.push(message.type);
    });

    const unsubscribe = bus.subscribe("executor", handler);
    bus.subscribeAll(handler);

    await bus.publish(
      createProtocolMessage({
        conversationId: "c1",
        round: 1,
        from: "reviewer",
        to: "executor",
        type: MessageType.Warning,
        content: { message: "Approaching message budget" },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([MessageType.Warning, MessageType.Warning]);

    unsubscribe();
    await bus.publish(
      createProtocolMessage({
        conversationId: "c1",
        round: 1,
        from: "reviewer",
        to: "executor",
        type: MessageType.Status,
        content: { status: "ok" },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(3);
  });
});
