import { describe, expect, it } from "vitest";
import type { EngineEvent } from "#assentor/protocol/events.js";
import type { Transport, TransportStatus } from "./types.js";

/**
 * What every `Transport` must do (T04-06). A transport's own test file calls
 * `runTransportContract(name, make)`; the Tauri transport (T05-09) does the same.
 */

export interface ContractHarness {
  transport: Transport;
  sessionId: string;
  /** The session's events before the test starts: at least 3, seq 1..n. */
  events: EngineEvent[];
  /** Add one more event to the session as the engine would; resolves with it. */
  emit(): Promise<EngineEvent>;
  /** Whether the engine behind this transport grants it writes (what `canWrite` must report once open). */
  writeGranted: boolean;
  /** Cut the link. The transport must go `reconnecting` and then `open` again by itself. */
  drop(): void;
  dispose(): Promise<void> | void;
}

export const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

export function runTransportContract(name: string, make: () => Promise<ContractHarness>): void {
  describe(`Transport contract: ${name}`, () => {
    const withHarness = (body: (h: ContractHarness) => Promise<void>) => async () => {
      const harness = await make();
      try {
        await until(() => statusOf(harness.transport) === "open");
        await body(harness);
      } finally {
        harness.transport.close();
        await harness.dispose();
      }
    };

    it("reports the current status at once, then changes, and stops after the remover is called", withHarness(async ({ transport }) => {
      const seen: TransportStatus[] = [];
      const off = transport.onStatus((s) => seen.push(s));
      expect(seen).toEqual(["open"]);
      off();
      transport.close();
      expect(seen).toEqual(["open"]);
      expect(statusOf(transport)).toBe("closed");
    }));

    it("answers calls", withHarness(async ({ transport, sessionId }) => {
      expect((await transport.call("engine.hello", { client: "contract" })).engineVersion).toEqual(expect.any(String));
      const { sessions } = await transport.call("sessions.list");
      expect(sessions.map((s) => s.id)).toContain(sessionId);
    }));

    it("delivers a subscription's events in order, then live ones", withHarness(async ({ transport, sessionId, events, emit }) => {
      const got: number[] = [];
      await transport.subscribe(sessionId, 0, { onEvent: (e) => got.push(e.seq) });
      await until(() => got.length === events.length);
      const live = await emit();
      await until(() => got.length === events.length + 1);
      expect(got).toEqual([...events.map((e) => e.seq), live.seq]);
    }));

    it("starts after fromSeq", withHarness(async ({ transport, sessionId, events }) => {
      const got: number[] = [];
      await transport.subscribe(sessionId, 2, { onEvent: (e) => got.push(e.seq) });
      await until(() => got.length === events.length - 2);
      expect(got).toEqual(events.slice(2).map((e) => e.seq));
    }));

    it("stops delivering after unsubscribe", withHarness(async ({ transport, sessionId, events, emit }) => {
      const got: number[] = [];
      const sub = await transport.subscribe(sessionId, 0, { onEvent: (e) => got.push(e.seq) });
      await until(() => got.length === events.length);
      await sub.unsubscribe();
      await emit();
      await new Promise((r) => setTimeout(r, 50));
      expect(got).toHaveLength(events.length);
    }));

    it("goes reconnecting then open after the link drops; the old subscription ends and a new one resumes from a seq", withHarness(async ({ transport, sessionId, events, drop, emit }) => {
      const old: number[] = [];
      await transport.subscribe(sessionId, 0, { onEvent: (e) => old.push(e.seq) });
      await until(() => old.length === events.length);
      const seen: TransportStatus[] = [];
      transport.onStatus((s) => seen.push(s));
      drop();
      const missed = [await emit(), await emit()];
      await until(() => seen.at(-1) === "open" && seen.includes("reconnecting"));
      const got: number[] = [];
      await transport.subscribe(sessionId, events.length, { onEvent: (e) => got.push(e.seq) });
      await until(() => got.length === 2);
      expect(got).toEqual(missed.map((e) => e.seq));
      expect(old).toHaveLength(events.length); // the dropped subscription saw nothing more
    }));

    it("exposes whether writes were granted, only while open", withHarness(async ({ transport, writeGranted, drop }) => {
      expect(transport.canWrite).toBe(writeGranted);
      const seen: boolean[] = [];
      transport.onStatus((s) => seen.push(s === "open" && transport.canWrite)); // already set when `open` is announced
      drop();
      await until(() => seen.includes(false) && seen.at(-1) === writeGranted);
      expect(transport.canWrite).toBe(writeGranted);
      transport.close();
      expect(transport.canWrite).toBe(false);
    }));

    it("rejects calls once closed, and stays closed", withHarness(async ({ transport }) => {
      transport.close();
      await expect(transport.call("sessions.list")).rejects.toThrow();
      expect(statusOf(transport)).toBe("closed");
    }));
  });
}

function statusOf(transport: Transport): TransportStatus {
  let status: TransportStatus = "connecting";
  transport.onStatus((s) => (status = s))();
  return status;
}
