// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { parseEngineEvent, type EngineEvent } from "#assentor/protocol/events.js";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import { RpcRemoteError } from "#assentor/protocol/rpc-client.js";
import { App } from "../../App.js";
import { createEngineStore } from "../../store/engineStore.js";
import { leadFixture, sessionFixture } from "../../test/fixtures.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport, type MockTransportOptions } from "../../transport/mock.js";
import { LeadBoard } from "../lead-board/LeadBoard.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { SeatDrawer } from "../seat-drawer/SeatDrawer.js";
import { SessionActions as SessionActionsProbe } from "./SessionActions.js";
import { SessionBoard } from "../session-board/SessionBoard.js";

afterEach(() => cleanup());

const notSupported = () => {
  throw new RpcRemoteError({ code: RpcErrorCode.NotSupported, message: "seat.stop: no registry" });
};

interface Setup {
  write?: boolean;
  live?: "running" | "created" | "cancelling" | null;
  /** Open approval ids; read on every `session.get`, so a test can change it. */
  approvals?: { ids: string[] };
  handlers?: MockTransportOptions["handlers"];
}

function transportFor(id: string, setup: Setup) {
  const approvals = setup.approvals ?? { ids: [] };
  return mockTransport({
    canWrite: setup.write !== false,
    handlers: {
      "session.get": () => ({
        session: { id, title: "t", hasLiveLog: true, lastSeq: 1, ...(setup.live === null ? {} : { live: setup.live ?? "running" }) },
        pendingApprovals: approvals.ids,
      }),
      "session.cancel": () => ({ ok: true as const, live: "cancelling" as const }),
      "session.approve": () => ({ ok: true as const }),
      "seat.stop": () => ({ ok: true as const }),
      "seat.setModel": () => ({ ok: true as const }),
      ...setup.handlers,
    },
  });
}

function mount(ui: React.ReactElement, run: { id: string; events: EngineEvent[] }, setup: Setup = {}, extra: EngineEvent[] = []) {
  const store = createEngineStore();
  const transport = transportFor(run.id, setup);
  const rendered = renderWithStore(ui, store, transport);
  act(() => {
    store.getState().setConnection("connected", "t");
    store.getState().select(run.id);
    store.getState().applyEvents(run.id, [...run.events, ...extra]);
  });
  return { ...rendered, store, transport: transport as ReturnType<typeof mockTransport> };
}

const callsTo = (t: ReturnType<typeof mockTransport>, method: string) => t.calls.filter((c) => c.method === method);
const question = (run: { id: string; events: EngineEvent[] }, questionId: string, text: string): EngineEvent =>
  parseEngineEvent({
    type: "user.question",
    sessionId: run.id,
    seq: run.events.length + 1,
    at: "2026-10-25T12:00:00.000Z",
    data: { questionId, question: text, kind: "approval" },
  }) as EngineEvent;

/** Wait until the control hooks have read `engine.hello` and `session.get`. */
const ready = (t: ReturnType<typeof mockTransport>) => waitFor(() => expect(callsTo(t, "session.get").length).toBeGreaterThan(0));

describe("Cancel session", () => {
  const header = () => mount(<App />, sessionFixture);

  it("confirms first, then calls session.cancel with the session id", async () => {
    const { getByRole, queryByRole, transport } = header();
    await waitFor(() => expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBeNull());
    const opener = getByRole("button", { name: "Cancel session" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = getByRole("dialog", { name: "Cancel this session?" });
    expect(callsTo(transport, "session.cancel")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel session" }));
    await waitFor(() => expect(queryByRole("dialog", { name: "Cancel this session?" })).toBeNull());
    expect(callsTo(transport, "session.cancel")).toEqual([{ method: "session.cancel", params: { sessionId: sessionFixture.id } }]);
  });

  it("Escape closes the dialog without calling, and focus returns to the button", async () => {
    const { getByRole, queryByRole, transport } = header();
    await waitFor(() => expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBeNull());
    const opener = getByRole("button", { name: "Cancel session" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(within(getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(callsTo(transport, "session.cancel")).toHaveLength(0);
  });

  it("sends one call when confirm is clicked twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { getByRole, transport } = mount(<App />, sessionFixture, {
      handlers: { "session.cancel": async () => (await gate, { ok: true as const, live: "cancelling" as const }) },
    });
    await waitFor(() => expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(getByRole("button", { name: "Cancel session" }));
    const confirm = within(getByRole("dialog")).getByRole("button", { name: "Cancel session" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    await waitFor(() => expect(callsTo(transport, "session.cancel")).toHaveLength(1));
  });

  it("shows a failure as text and keeps the dialog open", async () => {
    const { getByRole, findByRole } = mount(<App />, sessionFixture, {
      handlers: { "session.cancel": () => { throw new Error("session is cancelling"); } },
    });
    await waitFor(() => expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(getByRole("button", { name: "Cancel session" }));
    fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: "Cancel session" }));
    expect((await findByRole("alert")).textContent).toBe("session is cancelling");
    expect(getByRole("dialog")).toBeTruthy();
  });

  it("is disabled with a reason on a read-only connection", async () => {
    const { getByRole, getAllByText, transport } = mount(<App />, sessionFixture, { write: false });
    await ready(transport);
    expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => expect(getAllByText(/read-only/).length).toBeGreaterThan(0));
  });

  it("is disabled with a reason when the session is not live", async () => {
    const { getByRole, getAllByText, transport } = mount(<App />, sessionFixture, { live: null });
    await ready(transport);
    await waitFor(() => expect(getAllByText("The session is not running on this engine.").length).toBeGreaterThan(0));
    expect(getByRole("button", { name: "Cancel session" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Shared state and accessibility", () => {
  it("one session.get serves every control, and a disabled control stays focusable, inert and described by its reason", async () => {
    const { getByRole, transport } = mount(<><SessionBoard /><SeatDrawer /><SessionActionsProbe /></>, sessionFixture, { write: false }, [question(sessionFixture, "q1", "Run it?")]);
    act(() => void 0);
    await waitFor(() => expect(getByRole("button", { name: "Cancel session" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(transport, "session.get")).toHaveLength(1);

    const cancel = getByRole("button", { name: "Cancel session" });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(cancel.getAttribute("aria-describedby")!)?.textContent).toMatch(/read-only/);
    fireEvent.click(cancel);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the approvals region is a polite live region that is mounted before any approval arrives", async () => {
    const { container } = mount(<SessionBoard />, sessionFixture);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});

describe("Pending approvals", () => {
  const ASK = () => question(sessionFixture, "q1", "Run the migration?");

  it("lists each open question; Approve and Deny call session.approve and the list updates", async () => {
    const approvals = { ids: ["q1", "q2"] };
    const extra = [
      question(sessionFixture, "q1", "Run the migration?"),
      { ...question(sessionFixture, "q2", "Delete the cache?"), seq: sessionFixture.events.length + 2 },
    ];
    const { getByRole, queryByText, transport } = mount(<SessionBoard />, sessionFixture, { approvals }, extra);
    const panel = await waitFor(() => getByRole("region", { name: "Pending approvals" }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);

    approvals.ids = ["q2"];
    fireEvent.click(within(panel).getByRole("button", { name: "Approve: Run the migration?" }));
    await waitFor(() => expect(queryByText("Run the migration?")).toBeNull());
    expect(callsTo(transport, "session.approve")).toEqual([{ method: "session.approve", params: { sessionId: sessionFixture.id, id: "q1", decision: "approve" } }]);

    approvals.ids = [];
    fireEvent.click(getByRole("button", { name: "Deny: Delete the cache?" }));
    await waitFor(() => expect(queryByText("Delete the cache?")).toBeNull());
    expect(callsTo(transport, "session.approve")[1]).toEqual({ method: "session.approve", params: { sessionId: sessionFixture.id, id: "q2", decision: "deny" } });
  });

  it("a static stage gate (no question text) shows its id and cannot be denied", async () => {
    const { getByRole } = mount(<SessionBoard />, sessionFixture, { approvals: { ids: ["review-gate"] } });
    const panel = await waitFor(() => getByRole("region", { name: "Pending approvals" }));
    expect(within(panel).getByText("review-gate")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Deny: review-gate" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(panel).getByRole("button", { name: "Approve: review-gate" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("disables both buttons with the reason on a read-only connection, and shows engine errors as text", async () => {
    const ro = mount(<SessionBoard />, sessionFixture, { write: false, approvals: { ids: ["q1"] } }, [ASK()]);
    const panel = await waitFor(() => ro.getByRole("region", { name: "Pending approvals" }));
    await waitFor(() => expect(within(panel).getByText(/read-only/)).toBeTruthy());
    expect(within(panel).getByRole("button", { name: /^Approve/ }).getAttribute("aria-disabled")).toBe("true");
    cleanup();

    const failing = mount(<SessionBoard />, sessionFixture, {
      approvals: { ids: ["q1"] },
      handlers: { "session.approve": () => { throw new Error("no pending approval with that id"); } },
    }, [ASK()]);
    const p2 = await waitFor(() => failing.getByRole("region", { name: "Pending approvals" }));
    await waitFor(() => expect(within(p2).getByRole("button", { name: /^Approve/ }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(within(p2).getByRole("button", { name: /^Approve/ }));
    expect((await failing.findByRole("alert")).textContent).toBe("no pending approval with that id");
  });
});

describe("Lead board: approve integration", () => {
  it("maps the integrate approval to Approve integration, behind a confirm dialog", async () => {
    const extra = [question(leadFixture, "q-int", "Integrate the accepted tasks into main?")];
    const { getByRole, queryByRole, transport } = mount(<LeadBoard />, leadFixture, { approvals: { ids: ["q-int"] } }, extra);
    const panel = await waitFor(() => getByRole("region", { name: "Pending approvals" }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: /^Approve integration:/ }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(within(panel).getByRole("button", { name: /^Approve integration:/ }));

    const dialog = getByRole("dialog", { name: "Approve integration?" });
    expect(within(dialog).getByText("Integrate the accepted tasks into main?")).toBeTruthy();
    expect(callsTo(transport, "session.approve")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve integration" }));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(callsTo(transport, "session.approve")).toEqual([{ method: "session.approve", params: { sessionId: leadFixture.id, id: "q-int", decision: "approve" } }]);
  });
});

describe("Seat drawer actions", () => {
  const openDrawer = (setup: Setup = {}, seatId = "executor") => {
    const m = mount(<><SessionBoard /><SeatDrawer /></>, sessionFixture, setup);
    act(() => m.store.getState().openSeat(seatId));
    return m;
  };
  // The fixture's executor is done; liveRun() puts it back to writing.
  const liveRun = () => {
    const events = sessionFixture.events;
    const seq = events.length;
    return {
      id: sessionFixture.id,
      events: [
        ...events,
        parseEngineEvent({ type: "seat.status", sessionId: sessionFixture.id, seatId: "executor", seq: seq + 1, at: "2026-10-25T12:00:00.000Z", data: { status: "writing" } }) as EngineEvent,
      ],
    };
  };
  const openLive = (setup: Setup = {}) => {
    const m = mount(<><SessionBoard /><SeatDrawer /></>, liveRun(), setup);
    act(() => m.store.getState().openSeat("executor"));
    return m;
  };

  it("Stop seat confirms, then calls seat.stop", async () => {
    const { getByRole, queryByRole, transport } = openLive();
    const drawer = getByRole("dialog", { name: "Executor" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Stop seat" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(within(drawer).getByRole("button", { name: "Stop seat" }));
    const dialog = getByRole("dialog", { name: "Stop Executor?" });
    expect(callsTo(transport, "seat.stop")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop seat" }));
    await waitFor(() => expect(queryByRole("dialog", { name: "Stop Executor?" })).toBeNull());
    expect(callsTo(transport, "seat.stop")).toEqual([{ method: "seat.stop", params: { sessionId: sessionFixture.id, seatId: "executor", confirm: true } }]);
  });

  it("shows NotSupported as a plain message", async () => {
    const { getByRole, findByRole } = openLive({ handlers: { "seat.stop": notSupported } });
    const drawer = getByRole("dialog", { name: "Executor" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Stop seat" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(within(drawer).getByRole("button", { name: "Stop seat" }));
    fireEvent.click(within(getByRole("dialog", { name: "Stop Executor?" })).getByRole("button", { name: "Stop seat" }));
    expect((await findByRole("alert")).textContent).toBe("Not supported by this engine yet.");
  });

  it("Change model rejects an invalid id client-side and sends a valid one", async () => {
    const { getByRole, findByText, transport } = openLive();
    const drawer = getByRole("dialog", { name: "Executor" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Change model" }).getAttribute("aria-disabled")).toBeNull());
    const input = within(drawer).getByLabelText("Model");

    fireEvent.change(input, { target: { value: "-bad id" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Change model" }));
    expect(within(drawer).getByRole("alert").textContent).toMatch(/model must be AUTO or an id/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(callsTo(transport, "seat.setModel")).toHaveLength(0);

    fireEvent.change(input, { target: { value: "claude-opus-4.5" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Change model" }));
    expect(await findByText("Model change to claude-opus-4.5 requested.")).toBeTruthy();
    expect(callsTo(transport, "seat.setModel")).toEqual([{ method: "seat.setModel", params: { sessionId: sessionFixture.id, seatId: "executor", model: "claude-opus-4.5" } }]);
  });

  it("Change model shows NotSupported as a plain message", async () => {
    const { getByRole, findByRole } = openLive({
      handlers: { "seat.setModel": () => { throw new RpcRemoteError({ code: RpcErrorCode.NotSupported, message: "x" }); } },
    });
    const drawer = getByRole("dialog", { name: "Executor" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Change model" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.change(within(drawer).getByLabelText("Model"), { target: { value: "AUTO" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Change model" }));
    expect((await findByRole("alert")).textContent).toBe("Not supported by this engine yet.");
  });

  it("is disabled with a reason without write access, and for a finished seat", async () => {
    const ro = openLive({ write: false });
    await ready(ro.transport);
    await waitFor(() => expect(within(ro.getByRole("dialog", { name: "Executor" })).getAllByText(/read-only/)).toHaveLength(4));
    expect(within(ro.getByRole("dialog", { name: "Executor" })).getByRole("button", { name: "Stop seat" }).getAttribute("aria-disabled")).toBe("true");
    cleanup();

    const done = openDrawer({}, "reviewer-1");
    const drawer = done.getByRole("dialog", { name: "Opus#1" });
    await waitFor(() => expect(within(drawer).getAllByText("This seat has finished.")).toBeTruthy());
    expect(within(drawer).getByRole("button", { name: "Stop seat" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(drawer).getByRole("button", { name: "Change model" }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Palette write commands", () => {
  const palette = (setup: Setup = {}, extra: EngineEvent[] = []) => {
    const closed: boolean[] = [];
    const m = mount(<CommandPalette onClose={() => closed.push(true)} />, liveSession(), setup, extra);
    return { ...m, closed };
  };
  function liveSession() {
    const seq = sessionFixture.events.length;
    return {
      id: sessionFixture.id,
      events: [
        ...sessionFixture.events,
        parseEngineEvent({ type: "seat.status", sessionId: sessionFixture.id, seatId: "executor", seq: seq + 1, at: "2026-10-25T12:00:00.000Z", data: { status: "writing" } }) as EngineEvent,
      ],
    };
  }
  const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    // The typed command is the first, active option once write access is known.
    await waitFor(() => expect(document.querySelector(".palette-option.is-active")?.getAttribute("aria-disabled")).toBeNull());
  };
  const enter = () => fireEvent.keyDown(input(), { key: "Enter" });

  it("/cancel asks first, then calls session.cancel and closes", async () => {
    const { getByRole, closed, transport } = palette();
    await ready(transport);
    await type("/cancel");
    enter();
    const dialog = getByRole("dialog", { name: "Cancel this session?" });
    expect(callsTo(transport, "session.cancel")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel session" }));
    await waitFor(() => expect(closed).toEqual([true]));
    expect(callsTo(transport, "session.cancel")).toEqual([{ method: "session.cancel", params: { sessionId: sessionFixture.id } }]);
  });

  it("Escape in the confirm dialog leaves the palette open", async () => {
    const { getByRole, closed, transport } = palette();
    await ready(transport);
    await type("/cancel");
    enter();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual([]);
    expect(getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(callsTo(transport, "session.cancel")).toHaveLength(0);
  });

  it("/approve confirms the single pending approval and sends session.approve", async () => {
    const { getByRole, closed, transport } = palette({ approvals: { ids: ["q1"] } }, [question({ id: sessionFixture.id, events: liveSession().events }, "q1", "Run the migration?")]);
    await waitFor(() => expect(callsTo(transport, "session.get").length).toBeGreaterThan(0));
    await type("/approve");
    await waitFor(() => expect(document.querySelector(".palette-label")?.textContent).toBe("Run /approve"));
    enter();
    const dialog = getByRole("dialog", { name: "Approve?" });
    expect(within(dialog).getByText("Run the migration?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(closed).toEqual([true]));
    expect(callsTo(transport, "session.approve")).toEqual([{ method: "session.approve", params: { sessionId: sessionFixture.id, id: "q1", decision: "approve" } }]);
  });

  it("/approve with nothing pending says so", async () => {
    const { getByRole, transport } = palette();
    await ready(transport);
    await type("/approve");
    enter();
    expect(within(getByRole("dialog", { name: "Command palette" })).getByRole("status").textContent).toBe("No approval is pending.");
    expect(callsTo(transport, "session.approve")).toHaveLength(0);
  });

  it("/stop <seat> confirms and calls seat.stop (seat by display name too)", async () => {
    const { getByRole, closed, transport } = palette();
    await ready(transport);
    await type("/stop Executor");
    enter();
    fireEvent.click(within(getByRole("dialog", { name: "Stop Executor?" })).getByRole("button", { name: "Stop seat" }));
    await waitFor(() => expect(closed).toEqual([true]));
    expect(callsTo(transport, "seat.stop")).toEqual([{ method: "seat.stop", params: { sessionId: sessionFixture.id, seatId: "executor", confirm: true } }]);
  });

  it("/stop shows NotSupported in the dialog", async () => {
    const { getByRole, findByRole, transport } = palette({ handlers: { "seat.stop": notSupported } });
    await ready(transport);
    await type("/stop executor");
    enter();
    fireEvent.click(within(getByRole("dialog", { name: "Stop Executor?" })).getByRole("button", { name: "Stop seat" }));
    expect((await findByRole("alert")).textContent).toBe("Not supported by this engine yet.");
  });

  it("/model <seat> <model> calls seat.setModel; an invalid model is listed disabled with the reason", async () => {
    const { getByRole, closed, transport } = palette();
    await ready(transport);
    await type("/model executor gpt-5.1");
    enter();
    await waitFor(() => expect(closed).toEqual([true]));
    expect(callsTo(transport, "seat.setModel")).toEqual([{ method: "seat.setModel", params: { sessionId: sessionFixture.id, seatId: "executor", model: "gpt-5.1" } }]);

    fireEvent.change(input(), { target: { value: "/model executor -x" } });
    const option = getByRole("option", { name: /Run \/model executor -x/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toMatch(/model must be AUTO or an id/);
  });

  it("/model with an unknown seat says so and calls nothing", async () => {
    const { getByRole, transport } = palette();
    await ready(transport);
    await type("/model ghost AUTO");
    enter();
    expect(within(getByRole("dialog", { name: "Command palette" })).getByRole("status").textContent).toBe("No seat named “ghost”.");
    expect(callsTo(transport, "seat.setModel")).toHaveLength(0);
  });

  it("lists the commands disabled with a reason on a read-only connection; so do /pause, /resume, /inject and /restart", async () => {
    const { getByRole, transport } = palette({ write: false });
    await ready(transport);
    await waitFor(() => expect(document.querySelector(".palette-option .palette-reason")?.textContent).toMatch(/read-only/));
    fireEvent.change(input(), { target: { value: "/cancel" } });
    const cancel = getByRole("option", { name: /^Run \/cancel/ });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    enter();
    expect(callsTo(transport, "session.cancel")).toHaveLength(0);

    for (const [typed, label] of [["/inject executor hi", /^Run \/inject/], ["/pause", /^Run \/pause/], ["/resume", /^Run \/resume/], ["/restart executor", /^Run \/restart/]] as const) {
      fireEvent.change(input(), { target: { value: typed } });
      const option = getByRole("option", { name: label });
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(option.textContent).toMatch(/read-only/);
    }
  });

  it("selecting the /model template fills the search box", async () => {
    const { transport } = palette();
    await ready(transport);
    fireEvent.change(input(), { target: { value: "model" } });
    await waitFor(() => expect(document.querySelector(".palette-option.is-active")?.getAttribute("aria-disabled")).toBeNull());
    enter();
    expect(input().value).toBe("/model ");
  });
});
