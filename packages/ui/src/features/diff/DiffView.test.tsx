// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithStore } from "../../test/render.js";
import { sessionFixture } from "../../test/fixtures.js";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { DiffView } from "./DiffView.js";

afterEach(() => cleanup());

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-<img src=x onerror=alert(1)>",
  "+const x = 1;",
].join("\n");

function setup(opts: { write?: boolean; live?: "running"; truncated?: boolean } = {}) {
  const transport = mockTransport({
    handlers: {
      "engine.hello": () => ({
        engineVersion: "t",
        protocolVersion: 1,
        capabilities: opts.write ? ["worktree.diff", "worktree.apply", "worktree.discard"] : ["worktree.diff"],
      }),
      "session.get": () => ({ session: { id: sessionFixture.id, title: "t", hasLiveLog: true, lastSeq: 1, ...(opts.live ? { live: opts.live } : {}) }, pendingApprovals: [] }),
      "worktree.diff": () => ({ baseSha: "abcdef0123", head: "0123abcdef", dirty: false, files: ["src/a.ts", "src/b.ts"], diff: DIFF, truncated: Boolean(opts.truncated) }),
      "worktree.apply": () => ({ ok: true, strategy: "squash", changed: true, commit: "feedface00" }),
      "worktree.discard": () => ({ ok: true }),
    },
  });
  const store = createEngineStore();
  const view = renderWithStore(<DiffView />, store, transport);
  act(() => {
    store.getState().select(sessionFixture.id);
    store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
  });
  return { ...view, transport };
}

async function openDiff(v: ReturnType<typeof setup>) {
  fireEvent.click(v.getByRole("button", { name: /Diff & worktrees/ }));
  fireEvent.click((await v.findAllByRole("button", { name: "View diff" }))[0]!);
  await v.findByText("@@ -1 +1 @@");
}

describe("DiffView", () => {
  it("renders the diff as text, never as HTML", async () => {
    const v = setup({ write: true });
    await openDiff(v);
    expect(v.getByText("-<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(v.container.querySelector("img")).toBeNull();
    expect(v.getByRole("button", { name: "src/b.ts" })).toBeTruthy();
  });

  it("asks for confirmation before apply and discard, then sends confirm:true", async () => {
    const v = setup({ write: true });
    await openDiff(v);
    await waitFor(() => expect((v.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(v.getByRole("button", { name: "Apply…" }));
    const dialog = v.getByRole("dialog");
    expect(within(dialog).getByText("src/b.ts")).toBeTruthy();
    expect(v.transport.calls.some((c) => c.method === "worktree.apply")).toBe(false);
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "merge" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(v.transport.calls.find((c) => c.method === "worktree.apply")?.params).toMatchObject({ confirm: true, strategy: "merge", seatId: "executor" }));
    await v.findByText(/Applied \(squash\)/);

    fireEvent.click(v.getByRole("button", { name: "Discard…" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(v.queryByRole("dialog")).toBeNull();
    expect(v.transport.calls.some((c) => c.method === "worktree.discard")).toBe(false);
    fireEvent.click(v.getByRole("button", { name: "Discard…" }));
    fireEvent.click(within(v.getByRole("dialog")).getByRole("checkbox"));
    fireEvent.click(within(v.getByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(v.transport.calls.find((c) => c.method === "worktree.discard")?.params).toMatchObject({ confirm: true, force: true }));
  });

  it("keeps focus inside the dialog and restores it on close", async () => {
    const v = setup({ write: true });
    await openDiff(v);
    const apply = (await v.findByRole("button", { name: "Apply…" })) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    apply.focus();
    fireEvent.click(apply);
    const dialog = v.getByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(apply);
  });

  it("disables apply and discard with a reason without write capability", async () => {
    const v = setup({ write: false });
    await openDiff(v);
    expect((v.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((v.getByRole("button", { name: "Discard…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(v.getByText(/--allow-write/)).toBeTruthy();
  });

  it("disables them while the session is live", async () => {
    const v = setup({ write: true, live: "running" });
    await openDiff(v);
    await v.findByText(/session is running/);
    expect((v.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a truncation notice", async () => {
    const v = setup({ write: true, truncated: true });
    await openDiff(v);
    expect(v.getByText(/cut at 512 KiB/)).toBeTruthy();
    expect(v.getByText(/No diff text \(cut off\)/)).toBeTruthy();
  });
});
