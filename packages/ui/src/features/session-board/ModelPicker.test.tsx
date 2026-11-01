// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { EngineEvent } from "#assentor/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport, type MockTransportOptions } from "../../transport/mock.js";
import { SessionBoard } from "./SessionBoard.js";
import { liveRun } from "./boardTestUtil.js";

afterEach(cleanup);

const ID = "model-run";
const handlers: MockTransportOptions["handlers"] = {
  "models.catalog": () => ({ entries: [{ id: "model-a", label: "Model A", source: "seed" }, { id: "model-b", label: "Model B", source: "seed" }] }),
  "seat.setModel": () => ({ ok: true }),
};

function setup(options: MockTransportOptions = {}, events: EngineEvent[] = liveRun(ID)) {
  const transport = mockTransport({ handlers, ...options });
  const rendered = renderWithStore(<SessionBoard />, undefined, transport);
  act(() => {
    rendered.store.getState().select(ID);
    rendered.store.getState().applyEvents(ID, events);
  });
  const picker = (name: string) => rendered.getByLabelText(`Model for ${name}`) as HTMLSelectElement;
  return { ...rendered, transport, picker };
}

const modelChanged = (seq: number, pending: boolean): EngineEvent =>
  ({ seq, sessionId: ID, seatId: "executor", at: new Date(Date.UTC(2026, 9, 25, 12, 0, seq)).toISOString(), type: "seat.model.changed", data: { from: "AUTO", to: "model-b", pending } }) as EngineEvent;

describe("ModelPicker", () => {
  it("lists the catalog of the seat's provider, once per provider", async () => {
    const { picker, transport } = setup();
    await waitFor(() => expect([...picker("Executor").options].map((o) => o.value)).toEqual(["model-a", "model-b", "AUTO"]));
    expect(picker("Executor").value).toBe("AUTO");
    expect(transport.calls.filter((c) => c.method === "models.catalog")).toEqual([{ method: "models.catalog", params: { provider: "mock" } }]);
  });

  it("choosing a model calls seat.setModel and shows pending until seat.model.changed arrives with pending:false", async () => {
    const { picker, transport, store, queryByText, getByText } = setup();
    await waitFor(() => expect(picker("Executor").getAttribute("aria-disabled")).toBeNull());
    fireEvent.change(picker("Executor"), { target: { value: "model-b" } });
    await waitFor(() => expect(getByText("pending: applies at the next turn")).toBeTruthy());
    expect(transport.calls.find((c) => c.method === "seat.setModel")!.params).toEqual({ sessionId: ID, seatId: "executor", model: "model-b" });
    expect(picker("Executor").value).toBe("model-b");

    act(() => store.getState().applyEvents(ID, [modelChanged(50, true)]));
    expect(getByText("pending: applies at the next turn")).toBeTruthy();
    expect(store.getState().session!.seats.executor!.model).toBe("AUTO");

    act(() => store.getState().applyEvents(ID, [modelChanged(51, false)]));
    expect(queryByText("pending: applies at the next turn")).toBeNull();
    expect(store.getState().session!.seats.executor!.model).toBe("model-b");
    expect(picker("Executor").value).toBe("model-b");
  });

  it("is off with a reason on a read-only connection", async () => {
    const { picker, getAllByText, transport } = setup({ canWrite: false });
    await waitFor(() => expect(picker("Executor").options.length).toBeGreaterThan(1));
    expect(picker("Executor").getAttribute("aria-disabled")).toBe("true");
    expect(getAllByText("Read-only connection")).toHaveLength(2);
    fireEvent.change(picker("Executor"), { target: { value: "model-b" } });
    expect(transport.calls.some((c) => c.method === "seat.setModel")).toBe(false);
  });

  it("is off with a reason once the seat has finished; other seats stay on", async () => {
    const done = { seq: 90, sessionId: ID, seatId: "executor", at: new Date(Date.UTC(2026, 9, 25, 12, 0, 0)).toISOString(), type: "seat.done", data: { ok: true } } as EngineEvent;
    const { picker, getByText } = setup({}, [...liveRun(ID), done]);
    expect(picker("Executor").getAttribute("aria-disabled")).toBe("true");
    expect(getByText("Seat finished")).toBeTruthy();
    await waitFor(() => expect(picker("Reviewer").getAttribute("aria-disabled")).toBeNull());
  });

  it("shows the engine's error when seat.setModel fails", async () => {
    const { picker, findByRole } = setup({
      handlers: { ...handlers, "seat.setModel": () => Promise.reject(new Error("seat has no executor")) },
    });
    await waitFor(() => expect(picker("Executor").getAttribute("aria-disabled")).toBeNull());
    fireEvent.change(picker("Executor"), { target: { value: "model-a" } });
    expect((await findByRole("alert")).textContent).toBe("seat has no executor");
  });
});
