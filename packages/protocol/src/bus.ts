import type { ProtocolMessage } from "./messages.js";

export type MessageHandler = (message: ProtocolMessage) => void | Promise<void>;

/**
 * In-memory protocol bus.
 * All agent communication is routed through the supervisor via this bus —
 * adapters never call each other directly.
 */
export class ProtocolBus {
  private readonly inbox = new Map<string, ProtocolMessage[]>();
  private readonly history: ProtocolMessage[] = [];
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly globalHandlers = new Set<MessageHandler>();

  async publish(message: ProtocolMessage): Promise<void> {
    this.history.push(message);

    const queue = this.inbox.get(message.to) ?? [];
    queue.push(message);
    this.inbox.set(message.to, queue);

    const recipientHandlers = this.handlers.get(message.to);
    if (recipientHandlers) {
      for (const handler of recipientHandlers) {
        await handler(message);
      }
    }

    for (const handler of this.globalHandlers) {
      await handler(message);
    }
  }

  /**
   * Drain queued messages for an agent (FIFO).
   */
  receive(agentId: string): ProtocolMessage[] {
    const queued = this.inbox.get(agentId) ?? [];
    this.inbox.set(agentId, []);
    return queued;
  }

  peek(agentId: string): readonly ProtocolMessage[] {
    return this.inbox.get(agentId) ?? [];
  }

  pendingCount(agentId: string): number {
    return this.peek(agentId).length;
  }

  getHistory(filter?: {
    conversationId?: string;
    round?: number;
    from?: string;
    to?: string;
    type?: ProtocolMessage["type"];
  }): readonly ProtocolMessage[] {
    if (!filter) {
      return this.history;
    }

    return this.history.filter((message) => {
      if (
        filter.conversationId !== undefined &&
        message.conversationId !== filter.conversationId
      ) {
        return false;
      }
      if (filter.round !== undefined && message.round !== filter.round) {
        return false;
      }
      if (filter.from !== undefined && message.from !== filter.from) {
        return false;
      }
      if (filter.to !== undefined && message.to !== filter.to) {
        return false;
      }
      if (filter.type !== undefined && message.type !== filter.type) {
        return false;
      }
      return true;
    });
  }

  subscribe(agentId: string, handler: MessageHandler): () => void {
    const set = this.handlers.get(agentId) ?? new Set<MessageHandler>();
    set.add(handler);
    this.handlers.set(agentId, set);

    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(agentId);
      }
    };
  }

  subscribeAll(handler: MessageHandler): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  clear(): void {
    this.inbox.clear();
    this.history.length = 0;
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}
