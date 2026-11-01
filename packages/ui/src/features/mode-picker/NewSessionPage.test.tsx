// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import { RpcRemoteError } from "#assentor/protocol/rpc-client.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport } from "../../transport/mock.js";
import { MODE_CATALOG, UNAVAILABLE_REASON } from "./modeCatalog.js";
import { NewSessionPage } from "./NewSessionPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const WRITE_CAPABILITIES = ["engine.hello", "sessions.list", "session.create", "session.start"];

/** Renders the page on an open, writable connection unless the options say otherwise. */
function setup(options: { capabilities?: string[]; create?: () => unknown; start?: () => unknown; cancel?: () => unknown } = {}) {
  const transport = mockTransport({
    handlers: {
      "engine.hello": () => ({ engineVersion: "0.4.0", protocolVersion: 1, capabilities: options.capabilities ?? WRITE_CAPABILITIES }),
      "session.create": (options.create ?? (() => ({ sessionId: "s-new", mode: "solo", autonomy: "manual" }))) as never,
      "session.start": (options.start ?? (() => ({ sessionId: "s-new", live: "running" }))) as never,
      "session.cancel": (options.cancel ?? (() => ({ ok: true, live: "created" }))) as never,
    },
  });
  const rendered = renderWithStore(<NewSessionPage />, undefined, transport);
  act(() => rendered.store.getState().setConnection("connected", "0.4.0"));
  return { ...rendered, transport };
}

const modeGroup = () => document.querySelector<HTMLFieldSetElement>("fieldset.mode-fieldset")!;
const modeInput = (id: string) => document.querySelector<HTMLInputElement>(`input[name="mode"][value="${id}"]`)!;
const submitButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const goalField = () => document.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')!;

describe("NewSessionPage", () => {
  it("shows one card per mode from the catalog, with kind, edits-code and default autonomy", async () => {
    const { getByRole } = setup();
    await waitFor(() => expect(submitButton().disabled).toBe(true)); // checked, no goal yet
    const group = within(modeGroup());
    expect(group.getAllByRole("radio")).toHaveLength(MODE_CATALOG.length);
    expect(group.getByText("Lead (Supervisor)")).toBeTruthy();
    expect(group.getAllByText("Default: supervised")).toHaveLength(MODE_CATALOG.length);
    expect(group.getAllByText("Dynamic").length).toBeGreaterThan(0);
    expect(group.getAllByText("Static").length).toBeGreaterThan(0);
    expect(group.getAllByText("Edits code").length).toBeGreaterThan(0);
    expect(getByRole("radio", { name: /Solo/ }).getAttribute("value")).toBe("solo");
  });

  it("disables unavailable modes and shows the reason on each", async () => {
    setup();
    await waitFor(() => expect(submitButton()).toBeTruthy());
    const unavailable = MODE_CATALOG.filter((m) => !m.available);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const card of unavailable) {
      const input = modeInput(card.id);
      expect(input.disabled).toBe(true);
      const reason = document.getElementById(input.getAttribute("aria-describedby")!);
      expect(card.reason).toBeTruthy();
      expect(reason?.textContent).toBe(card.reason);
    }
    // Watch is still unavailable; lead is runnable now.
    expect(modeInput("watch").disabled).toBe(true);
    expect(document.getElementById("mode-watch-reason")?.textContent).toBe(UNAVAILABLE_REASON);
    expect(modeInput("lead").disabled).toBe(false);
  });

  it("shows the goal hint only while the goal is empty", async () => {
    setup();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(document.getElementById("new-session-hint")?.textContent).toBe("Write a goal to create the session.");
    expect(submitButton().getAttribute("aria-describedby")).toBe("new-session-hint");
    fireEvent.change(goalField(), { target: { value: "x" } });
    expect(document.getElementById("new-session-hint")).toBeNull();
  });

  it("creates then starts with the chosen mode, goal and autonomy, and opens the session", async () => {
    const { transport, store } = setup();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.change(goalField(), { target: { value: "  Add average()  " } });
    fireEvent.click(document.querySelector<HTMLInputElement>('input[name="autonomy"][value="manual"]')!);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());

    await waitFor(() => expect(store.getState().selectedId).toBe("s-new"));
    const calls = transport.calls.filter((c) => c.method === "session.create" || c.method === "session.start");
    expect(calls).toEqual([
      { method: "session.create", params: { mode: "solo", goal: "Add average()", autonomy: "manual" } },
      { method: "session.start", params: { sessionId: "s-new" } },
    ]);
    expect(window.location.hash).toBe("#/sessions");
  });

  it("offers only manual and supervised autonomy and defaults to supervised", async () => {
    const { transport } = setup();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    const values = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="autonomy"]')).map((i) => i.value);
    expect(values).toEqual(["manual", "supervised"]);
    fireEvent.change(goalField(), { target: { value: "Plan the work" } });
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(transport.calls.some((c) => c.method === "session.start")).toBe(true));
    expect(transport.calls.find((c) => c.method === "session.create")?.params).toMatchObject({ autonomy: "supervised" });
  });

  it("shows the engine's NotSupported message plainly and does not start", async () => {
    const message = "session.create is not supported yet: this engine has no session host";
    const { transport } = setup({
      create: () => {
        throw new RpcRemoteError({ code: RpcErrorCode.NotSupported, message });
      },
    });
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.change(goalField(), { target: { value: "Plan the work" } });
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(message));
    expect(transport.calls.some((c) => c.method === "session.start")).toBe(false);
  });

  it("cancels a session that was created but did not start, and says so", async () => {
    const { transport } = setup({
      start: () => {
        throw new Error("worktree is locked");
      },
    });
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.change(goalField(), { target: { value: "Plan the work" } });
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Session s-new was created but did not start: worktree is locked. It has been cancelled.",
    );
    expect(transport.calls.filter((c) => c.method === "session.cancel").map((c) => c.params)).toEqual([{ sessionId: "s-new" }]);
  });

  it("says so when the cancel after a failed start also fails", async () => {
    setup({
      start: () => {
        throw new Error("worktree is locked");
      },
      cancel: () => {
        throw new Error("not live");
      },
    });
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.change(goalField(), { target: { value: "Plan the work" } });
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Cancelling it failed");
  });

  it("is disabled with a reason when the connection cannot write", async () => {
    setup({ capabilities: ["engine.hello", "sessions.list"] });
    await waitFor(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toContain("read-only"),
    );
    fireEvent.change(goalField(), { target: { value: "Plan the work" } });
    expect(goalField().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(modeGroup().disabled).toBe(true);
  });

  it("explains a missing link instead of checking capabilities", () => {
    const transport = mockTransport();
    const rendered = renderWithStore(<NewSessionPage />, undefined, transport);
    act(() => rendered.store.getState().setConnection("no_token"));
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Open the link printed by");
    expect(submitButton().disabled).toBe(true);
    expect(transport.calls.some((c) => c.method === "engine.hello")).toBe(false);
  });
});
