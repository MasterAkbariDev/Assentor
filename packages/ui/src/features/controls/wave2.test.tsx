// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { parseEngineEvent, type EngineEvent } from "#assentor/protocol/events.js";
import { RpcErrorCode, INJECT_MAX_BYTES } from "#assentor/protocol/rpc.js";
import { RpcRemoteError } from "#assentor/protocol/rpc-client.js";
import { App } from "../../App.js";
import { createEngineStore } from "../../store/engineStore.js";
import { leadFixture, sessionFixture } from "../../test/fixtures.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport, type MockTransportOptions } from "../../transport/mock.js";
import { LeadBoard } from "../lead-board/LeadBoard.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { SeatDrawer } from "../seat-drawer/SeatDrawer.js";
import { SessionBoard } from "../session-board/SessionBoard.js";

afterEach(() => cleanup());

type Run = { id: string; events: EngineEvent[] };
const rejected = (message: string) => () => {
  throw new RpcRemoteError({ code: RpcErrorCode.Rejected, message });
};
const OK = () => ({ ok: true as const });

function mount(ui: React.ReactElement, run: Run, opts: { write?: boolean; handlers?: MockTransportOptions["handlers"] } = {}) {
  const store = createEngineStore();
  const transport = mockTransport({
    canWrite: opts.write !== false,
    handlers: {
      "session.get": () => ({ session: { id: run.id, title: "t", hasLiveLog: true, lastSeq: 1, live: "running" as const }, pendingApprovals: [] }),
      "session.pause": OK,
      "session.resume": OK,
      "seat.inject": OK,
      "seat.restart": OK,
      "lead.override": OK,
      "lead.pin": OK,
      "lead.pause": OK,
      "lead.resume": OK,
      "models.catalog": () => ({ entries: [{ id: "opus", label: "Opus", source: "seed" as const }, { id: "sonnet", label: "Sonnet", source: "seed" as const }] }),
      ...opts.handlers,
    },
  });
  const rendered = renderWithStore(ui, store, transport);
  act(() => {
    store.getState().setConnection("connected", "t");
    store.getState().select(run.id);
    store.getState().applyEvents(run.id, run.events);
  });
  /** Apply one more event after mount, with the next seq. */
  const emit = (type: string, data: object = {}, seatId?: string) =>
    act(() => {
      const seq = store.getState().session!.lastSeq + 1;
      store.getState().applyEvents(run.id, [parseEngineEvent({ seq, sessionId: run.id, ...(seatId ? { seatId } : {}), type, data, at: "2026-10-31T12:00:00.000Z" })]);
    });
  return { ...rendered, store, emit, transport };
}
const callsTo = (t: ReturnType<typeof mockTransport>, method: string) => t.calls.filter((c) => c.method === method);
const enabled = (el: HTMLElement) => expect(el.getAttribute("aria-disabled")).toBeNull();
const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;

/** The fixture's executor is done; this puts it back to writing so its drawer controls are live. */
const liveRun = (): Run => ({
  id: sessionFixture.id,
  events: [
    ...sessionFixture.events,
    parseEngineEvent({ type: "seat.status", sessionId: sessionFixture.id, seatId: "executor", seq: sessionFixture.events.length + 1, at: "2026-10-25T12:00:00.000Z", data: { status: "writing" } }),
  ],
});

describe("Pause/Resume session (board header)", () => {
  it("Pause calls session.pause, the badge and Resume follow session.paused, Resume calls session.resume", async () => {
    const { getByRole, queryByText, getByText, emit, transport } = mount(<App />, sessionFixture);
    await waitFor(() => enabled(getByRole("button", { name: "Pause session" })));
    expect(queryByText("Session paused")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Pause session" }));
    await waitFor(() => expect(callsTo(transport, "session.pause")).toEqual([{ method: "session.pause", params: { sessionId: sessionFixture.id } }]));
    emit("session.paused");
    expect(getByText("Session paused")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Resume session" }));
    await waitFor(() => expect(callsTo(transport, "session.resume")).toEqual([{ method: "session.resume", params: { sessionId: sessionFixture.id } }]));
    emit("session.resumed");
    expect(queryByText("Session paused")).toBeNull();
    expect(getByRole("button", { name: "Pause session" })).toBeTruthy();
  });

  it("sends one call for a double click and shows a Rejected reason as text", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { getByRole, transport } = mount(<App />, sessionFixture, { handlers: { "session.pause": async () => (await gate, { ok: true as const }) } });
    await waitFor(() => enabled(getByRole("button", { name: "Pause session" })));
    fireEvent.click(getByRole("button", { name: "Pause session" }));
    fireEvent.click(getByRole("button", { name: "Pause session" }));
    release();
    await waitFor(() => expect(callsTo(transport, "session.pause")).toHaveLength(1));
    cleanup();

    const again = mount(<App />, sessionFixture, { handlers: { "session.pause": rejected("the session is already paused") } });
    await waitFor(() => enabled(again.getByRole("button", { name: "Pause session" })));
    fireEvent.click(again.getByRole("button", { name: "Pause session" }));
    expect((await again.findByRole("alert")).textContent).toBe("the session is already paused");
  });

  it("is disabled with a visible reason when read-only or not live", async () => {
    const ro = mount(<App />, sessionFixture, { write: false });
    await waitFor(() => expect(callsTo(ro.transport, "session.get").length).toBeGreaterThan(0));
    const button = ro.getByRole("button", { name: "Pause session" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(button)).toMatch(/read-only/);
    fireEvent.click(button);
    expect(callsTo(ro.transport, "session.pause")).toHaveLength(0);
    cleanup();

    const idle = mount(<App />, sessionFixture, { handlers: { "session.get": () => ({ session: { id: sessionFixture.id, title: "t", hasLiveLog: true, lastSeq: 1 }, pendingApprovals: [] }) } });
    await waitFor(() => expect(describedBy(idle.getByRole("button", { name: "Pause session" }))).toBe("The session is not running on this engine."));
  });
});

describe("Lead pause and session pause are separate", () => {
  it("shows each state on its own, and both together", async () => {
    const { getByRole, getAllByText, queryAllByText, emit } = mount(<App />, leadFixture);
    await waitFor(() => enabled(getByRole("button", { name: "Pause lead" })));
    expect(queryAllByText(/paused/i).filter((e) => e.getAttribute("role") === "status" || e.className.includes("badge"))).toHaveLength(0);

    emit("lead.action", { action: "pause", accepted: true, by: "user" });
    expect(getAllByText("Lead paused")).toHaveLength(1);
    expect(queryAllByText("Session paused")).toHaveLength(0);
    expect(getByRole("button", { name: "Resume lead" })).toBeTruthy();
    expect(getByRole("button", { name: "Pause session" })).toBeTruthy();

    emit("session.paused");
    expect(getAllByText("Lead paused")).toHaveLength(1);
    expect(getAllByText("Session paused")).toHaveLength(1);

    emit("lead.action", { action: "resume", accepted: true, by: "user" });
    expect(queryAllByText("Lead paused")).toHaveLength(0);
    expect(getAllByText("Session paused")).toHaveLength(1);
    expect(getByRole("button", { name: "Pause lead" })).toBeTruthy();
    expect(getByRole("button", { name: "Resume session" })).toBeTruthy();
  });

  it("Pause lead / Resume lead call lead.pause / lead.resume, not the session methods", async () => {
    const { getByRole, emit, transport } = mount(<LeadBoard />, leadFixture);
    await waitFor(() => enabled(getByRole("button", { name: "Pause lead" })));
    fireEvent.click(getByRole("button", { name: "Pause lead" }));
    await waitFor(() => expect(callsTo(transport, "lead.pause")).toEqual([{ method: "lead.pause", params: { sessionId: leadFixture.id } }]));
    emit("lead.action", { action: "pause", accepted: true, by: "user" });
    fireEvent.click(getByRole("button", { name: "Resume lead" }));
    await waitFor(() => expect(callsTo(transport, "lead.resume")).toEqual([{ method: "lead.resume", params: { sessionId: leadFixture.id } }]));
    expect(callsTo(transport, "session.pause")).toHaveLength(0);
    expect(callsTo(transport, "session.resume")).toHaveLength(0);
  });
});

describe("Seat drawer: Restart turn", () => {
  const open = (opts: Parameters<typeof mount>[2] = {}) => {
    const m = mount(<><SessionBoard /><SeatDrawer /></>, liveRun(), opts);
    act(() => m.store.getState().openSeat("executor"));
    return { ...m, drawer: m.getByRole("dialog", { name: "Executor" }) };
  };

  it("sends nothing before confirm, then seat.restart with confirm: true", async () => {
    const { drawer, getByRole, queryByRole, transport } = open();
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Restart turn" })));
    fireEvent.click(within(drawer).getByRole("button", { name: "Restart turn" }));
    const dialog = getByRole("dialog", { name: "Restart Executor's turn?" });
    expect(callsTo(transport, "seat.restart")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart turn" }));
    await waitFor(() => expect(queryByRole("dialog", { name: "Restart Executor's turn?" })).toBeNull());
    expect(callsTo(transport, "seat.restart")).toEqual([{ method: "seat.restart", params: { sessionId: sessionFixture.id, seatId: "executor", confirm: true } }]);
  });

  it("shows the engine's refusal reason in the dialog and keeps it open", async () => {
    const { drawer, getByRole, findByRole } = open({ handlers: { "seat.restart": rejected("seat executor has no turn running") } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Restart turn" })));
    fireEvent.click(within(drawer).getByRole("button", { name: "Restart turn" }));
    fireEvent.click(within(getByRole("dialog", { name: "Restart Executor's turn?" })).getByRole("button", { name: "Restart turn" }));
    expect((await findByRole("alert")).textContent).toBe("seat executor has no turn running");
    expect(getByRole("dialog", { name: "Restart Executor's turn?" })).toBeTruthy();
  });

  it("confirm clicked twice sends one call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { drawer, getByRole, transport } = open({ handlers: { "seat.restart": async () => (await gate, { ok: true as const }) } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Restart turn" })));
    fireEvent.click(within(drawer).getByRole("button", { name: "Restart turn" }));
    const confirm = within(getByRole("dialog", { name: "Restart Executor's turn?" })).getByRole("button", { name: "Restart turn" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    await waitFor(() => expect(callsTo(transport, "seat.restart")).toHaveLength(1));
  });

  it("is disabled with a visible reason when read-only", async () => {
    const { drawer, transport } = open({ write: false });
    await waitFor(() => expect(callsTo(transport, "session.get").length).toBeGreaterThan(0));
    const button = within(drawer).getByRole("button", { name: "Restart turn" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(button)).toMatch(/read-only/);
  });
});

describe("Seat drawer: Inject message", () => {
  const open = (opts: Parameters<typeof mount>[2] = {}, seatId = "executor") => {
    const m = mount(<><SessionBoard /><SeatDrawer /></>, liveRun(), opts);
    act(() => m.store.getState().openSeat(seatId));
    const drawer = m.getByRole("dialog", { name: seatId === "executor" ? "Executor" : "Opus#1" });
    return { ...m, drawer, box: () => within(drawer).getByLabelText("Message to seat") as HTMLTextAreaElement };
  };

  it("Enter sends seat.inject with the exact text and clears the box; Shift+Enter sends nothing", async () => {
    const { drawer, box, transport } = open();
    await waitFor(() => expect(callsTo(transport, "session.get").length).toBeGreaterThan(0));
    fireEvent.change(box(), { target: { value: "use tabs\nnot spaces" } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Send message" })));
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(callsTo(transport, "seat.inject")).toHaveLength(0);
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().value).toBe(""));
    expect(callsTo(transport, "seat.inject")).toEqual([{ method: "seat.inject", params: { sessionId: sessionFixture.id, seatId: "executor", text: "use tabs\nnot spaces" } }]);
    expect(within(drawer).getByRole("status", { name: "" }).textContent).toMatch(/queued/);
  });

  it("does not send on Enter while an IME composition is open, and sends once for a double Enter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { drawer, box, transport } = open({ handlers: { "seat.inject": async () => (await gate, { ok: true as const }) } });
    await waitFor(() => expect(callsTo(transport, "session.get").length).toBeGreaterThan(0));
    fireEvent.change(box(), { target: { value: "hello" } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Send message" })));
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(callsTo(transport, "seat.inject")).toHaveLength(0);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "Enter" });
    release();
    await waitFor(() => expect(callsTo(transport, "seat.inject")).toHaveLength(1));
  });

  it("counts UTF-8 bytes and refuses a message over the 8 KiB cap, with a reason", async () => {
    const { drawer, box, transport } = open();
    await waitFor(() => expect(callsTo(transport, "session.get").length).toBeGreaterThan(0));
    fireEvent.change(box(), { target: { value: "é€" } });
    expect(within(drawer).getByText(`5 / ${INJECT_MAX_BYTES} bytes`)).toBeTruthy();

    fireEvent.change(box(), { target: { value: "a".repeat(INJECT_MAX_BYTES) } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Send message" })));
    fireEvent.change(box(), { target: { value: "a".repeat(INJECT_MAX_BYTES) + "é" } });
    const send = within(drawer).getByRole("button", { name: "Send message" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(send)).toMatch(/over the 8 KiB limit/);
    expect(box().getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.click(send);
    expect(callsTo(transport, "seat.inject")).toHaveLength(0);
  });

  it("shows a Rejected reason as text and keeps the draft", async () => {
    const { drawer, box, findByRole } = open({ handlers: { "seat.inject": rejected("seat executor will not run again") } });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Send message" })).toBeTruthy());
    fireEvent.change(box(), { target: { value: "hi" } });
    await waitFor(() => enabled(within(drawer).getByRole("button", { name: "Send message" })));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect((await findByRole("alert")).textContent).toBe("seat executor will not run again");
    expect(box().value).toBe("hi");
  });

  it("is disabled with a visible reason when read-only or the seat has finished", async () => {
    const ro = open({ write: false });
    await waitFor(() => expect(callsTo(ro.transport, "session.get").length).toBeGreaterThan(0));
    fireEvent.change(ro.box(), { target: { value: "hi" } });
    fireEvent.keyDown(ro.box(), { key: "Enter" });
    expect(callsTo(ro.transport, "seat.inject")).toHaveLength(0);
    expect(ro.box().getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(within(ro.drawer).getByRole("button", { name: "Send message" }))).toMatch(/read-only/);
    cleanup();

    const done = open({}, "reviewer-1");
    await waitFor(() => expect(callsTo(done.transport, "session.get").length).toBeGreaterThan(0));
    await waitFor(() => expect(describedBy(within(done.drawer).getByRole("button", { name: "Send message" }))).toBe("This seat has finished."));
  });

  it("seat.injected shows in the Activity tab", () => {
    const { drawer, emit } = open();
    emit("seat.injected", { preview: "use tabs", chars: 8 }, "executor");
    expect(within(drawer).getByText("message queued for the next turn (8 chars): use tabs")).toBeTruthy();
  });
});

describe("Palette: /pause /resume /inject /restart", () => {
  const palette = () => {
    const closed: boolean[] = [];
    const m = mount(<CommandPalette onClose={() => closed.push(true)} />, liveRun());
    return { ...m, closed };
  };
  const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    await waitFor(() => expect(document.querySelector(".palette-option.is-active")?.getAttribute("aria-disabled")).toBeNull());
  };
  const enter = () => fireEvent.keyDown(input(), { key: "Enter" });

  it("/pause and /resume call session.pause / session.resume and close", async () => {
    const { transport, closed } = palette();
    await type("/pause");
    enter();
    await waitFor(() => expect(closed).toHaveLength(1));
    expect(callsTo(transport, "session.pause")).toEqual([{ method: "session.pause", params: { sessionId: sessionFixture.id } }]);
    await type("/resume");
    enter();
    await waitFor(() => expect(closed).toHaveLength(2));
    expect(callsTo(transport, "session.resume")).toEqual([{ method: "session.resume", params: { sessionId: sessionFixture.id } }]);
  });

  it("/inject <seat> <text> sends the text after the seat word, seat by id or display name", async () => {
    const { transport, closed } = palette();
    await type("/inject Executor  keep the  spacing");
    enter();
    await waitFor(() => expect(closed).toHaveLength(1));
    expect(callsTo(transport, "seat.inject")).toEqual([{ method: "seat.inject", params: { sessionId: sessionFixture.id, seatId: "executor", text: "keep the  spacing" } }]);
  });

  it("/inject over the cap says so and sends nothing; an unknown seat is named", async () => {
    const { transport, getByRole } = palette();
    await type("/inject executor " + "x".repeat(INJECT_MAX_BYTES + 1));
    enter();
    expect(getByRole("status", { name: "" }).textContent).toMatch(/over the 8 KiB limit/);
    await type("/inject nobody hi");
    enter();
    expect(getByRole("status", { name: "" }).textContent).toBe("No seat named “nobody”.");
    expect(callsTo(transport, "seat.inject")).toHaveLength(0);
  });

  it("/inject shows a Rejected reason in the palette", async () => {
    const m = mount(<CommandPalette onClose={() => undefined} />, liveRun(), { handlers: { "seat.inject": rejected("seat executor will not run again") } });
    fireEvent.change(input(), { target: { value: "/inject executor hi" } });
    await waitFor(() => expect(document.querySelector(".palette-option.is-active")?.getAttribute("aria-disabled")).toBeNull());
    enter();
    await waitFor(() => expect(m.getByRole("status", { name: "" }).textContent).toBe("seat executor will not run again"));
  });

  it("/restart <seat> asks first, then calls seat.restart with confirm: true; a refusal stays in the dialog", async () => {
    const { transport, getByRole, closed } = palette();
    await type("/restart executor");
    enter();
    const dialog = getByRole("dialog", { name: "Restart Executor's turn?" });
    expect(callsTo(transport, "seat.restart")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart turn" }));
    await waitFor(() => expect(closed).toHaveLength(1));
    expect(callsTo(transport, "seat.restart")).toEqual([{ method: "seat.restart", params: { sessionId: sessionFixture.id, seatId: "executor", confirm: true } }]);
    cleanup();

    const refused = mount(<CommandPalette onClose={() => undefined} />, liveRun(), { handlers: { "seat.restart": rejected("restart limit reached (3 per turn)") } });
    await type("/restart executor");
    enter();
    fireEvent.click(within(refused.getByRole("dialog", { name: "Restart Executor's turn?" })).getByRole("button", { name: "Restart turn" }));
    expect((await refused.findByRole("alert")).textContent).toBe("restart limit reached (3 per turn)");
  });
});

describe("Lead board: override, pin, log", () => {
  const board = (opts: Parameters<typeof mount>[2] = {}) => mount(<LeadBoard />, leadFixture, opts);
  const task = (m: ReturnType<typeof board>, id: string) => {
    const controls = m.getByText(`Controls for ${id}`).closest("details") as HTMLElement;
    fireEvent.click(within(controls).getByText(`Controls for ${id}`));
    return controls;
  };

  it("Override assignment: pick a seat, nothing sent until confirm, then lead.override with exact params", async () => {
    const m = board();
    const controls = task(m, "T1");
    await waitFor(() => enabled(within(controls).getByRole("button", { name: "Override assignment" })));
    fireEvent.click(within(controls).getByRole("button", { name: "Override assignment" }));
    const dialog = m.getByRole("dialog", { name: "Override T1?" });
    fireEvent.change(within(dialog).getByLabelText("New owner"), { target: { value: "seat-2" } });
    expect(callsTo(m.transport, "lead.override")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Override assignment" }));
    await waitFor(() => expect(m.queryByRole("dialog", { name: "Override T1?" })).toBeNull());
    expect(callsTo(m.transport, "lead.override")).toEqual([{ method: "lead.override", params: { sessionId: leadFixture.id, taskId: "T1", seatId: "seat-2" } }]);
  });

  it("Override needs a seat, and shows the engine's refusal as text", async () => {
    const m = board({ handlers: { "lead.override": rejected("task T1 is accepted") } });
    const controls = task(m, "T1");
    await waitFor(() => enabled(within(controls).getByRole("button", { name: "Override assignment" })));
    fireEvent.click(within(controls).getByRole("button", { name: "Override assignment" }));
    const dialog = m.getByRole("dialog", { name: "Override T1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Override assignment" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Pick a seat first.");
    expect(callsTo(m.transport, "lead.override")).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText("New owner"), { target: { value: "seat-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Override assignment" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("task T1 is accepted"));
  });

  it("Pin model offers the catalog, calls lead.pin with the model; Unpin sends null", async () => {
    const m = board();
    const controls = task(m, "T1");
    await waitFor(() => expect(within(controls).getByRole("option", { name: "opus" })).toBeTruthy());
    await waitFor(() => expect(describedBy(within(controls).getByRole("button", { name: "Pin model" }))).toBe("Pick a model first."));
    const pin = within(controls).getByRole("button", { name: "Pin model" });
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(pin)).toBe("Pick a model first.");
    fireEvent.change(within(controls).getByLabelText("Pin model for T1"), { target: { value: "opus" } });
    fireEvent.click(pin);
    await waitFor(() => expect(callsTo(m.transport, "lead.pin")).toEqual([{ method: "lead.pin", params: { sessionId: leadFixture.id, taskId: "T1", model: "opus" } }]));

    m.emit("lead.action", { action: "pin", accepted: true, by: "user", taskId: "T1", model: "opus", reason: "T1 pinned to opus" });
    expect(m.getByText("Pinned: opus")).toBeTruthy();
    fireEvent.click(within(controls).getByRole("button", { name: "Unpin model" }));
    await waitFor(() => expect(callsTo(m.transport, "lead.pin")[1]).toEqual({ method: "lead.pin", params: { sessionId: leadFixture.id, taskId: "T1", model: null } }));
    m.emit("lead.action", { action: "pin", accepted: true, by: "user", taskId: "T1", model: null });
    expect(m.queryByText("Pinned: opus")).toBeNull();
  });

  it("Unpin is disabled with a reason on an unpinned task; a refused pin shows its reason", async () => {
    const m = board({ handlers: { "lead.pin": rejected("model opus is not allowed on seat-1") } });
    const controls = task(m, "T1");
    await waitFor(() => expect(describedBy(within(controls).getByRole("button", { name: "Unpin model" }))).toBe("This task has no pinned model."));
    await waitFor(() => expect(within(controls).getByRole("option", { name: "opus" })).toBeTruthy());
    fireEvent.change(within(controls).getByLabelText("Pin model for T1"), { target: { value: "opus" } });
    await waitFor(() => enabled(within(controls).getByRole("button", { name: "Pin model" })));
    fireEvent.click(within(controls).getByRole("button", { name: "Pin model" }));
    expect((await within(controls).findByRole("alert")).textContent).toBe("model opus is not allowed on seat-1");
  });

  it("task controls are disabled with a visible reason when read-only; accepted tasks have none", async () => {
    const m = board({ write: false });
    const controls = task(m, "T1");
    await waitFor(() => expect(callsTo(m.transport, "session.get").length).toBeGreaterThan(0));
    for (const name of ["Override assignment", "Pin model", "Unpin model"]) {
      const b = within(controls).getByRole("button", { name });
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(b)).toMatch(/read-only/);
    }
    expect(m.queryByText("Controls for T3")).toBeNull();
  });

  it("marks the user's own actions in the Lead log", () => {
    const m = board();
    m.emit("lead.action", { action: "override", accepted: false, by: "user", reason: "T1 is busy", taskId: "T1", seatId: "seat-2" });
    const entries = Array.from(document.querySelectorAll(".lead-entry"));
    const mine = entries.filter((e) => e.textContent?.includes("You: "));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.textContent).toContain("override");
    expect(mine[0]!.textContent).toContain("T1 is busy");
    expect(entries.filter((e) => !e.textContent?.includes("You: ")).length).toBeGreaterThan(0);
  });
});
