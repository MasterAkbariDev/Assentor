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

type Handlers = NonNullable<Parameters<typeof mockTransport>[0]>["handlers"];
function setup(opts: { write?: boolean; live?: "running"; truncated?: boolean; handlers?: Handlers } = {}) {
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
      ...opts.handlers,
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

  async function openApply(v: ReturnType<typeof setup>) {
    await openDiff(v);
    await waitFor(() => expect((v.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(v.getByRole("button", { name: "Apply…" }));
    return v.getByRole("dialog");
  }
  const applyCalls = (v: ReturnType<typeof setup>) => v.transport.calls.filter((c) => c.method === "worktree.apply");

  it("sends allowedPaths and names the seat and the target", async () => {
    const v = setup({ write: true });
    const dialog = await openApply(v);
    expect(within(dialog).getByText(/current branch in the main checkout/)).toBeTruthy();
    expect(within(dialog).getByText(/left staged and uncommitted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyCalls(v)[0]?.params).toMatchObject({ allowedPaths: ["src/a.ts", "src/b.ts"] }));
  });

  it("refuses a stale diff: no apply call, the dialog shows the new file list", async () => {
    let n = 0;
    const v = setup({
      write: true,
      handlers: {
        "worktree.diff": () => ({ baseSha: "abcdef0123", head: ++n > 1 ? "99999999" : "0123abcdef", dirty: false, files: n > 1 ? ["src/a.ts", "src/c.ts"] : ["src/a.ts", "src/b.ts"], diff: DIFF, truncated: false }),
      },
    });
    const dialog = await openApply(v);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/changed since/);
    expect(applyCalls(v)).toHaveLength(0);
    expect(within(dialog).getByText("src/c.ts")).toBeTruthy();
  });

  it("shows an apply error inside the dialog and keeps it open", async () => {
    const v = setup({
      write: true,
      handlers: {
        "worktree.apply": () => {
          throw new Error("boom");
        },
      },
    });
    const dialog = await openApply(v);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("boom");
    expect(v.getByRole("dialog")).toBe(dialog);
  });

  it("prevents a double submit and ignores Escape while working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const v = setup({
      write: true,
      handlers: {
        "worktree.apply": async () => {
          await gate;
          return { ok: true, strategy: "squash", changed: true };
        },
      },
    });
    const dialog = await openApply(v);
    const confirm = within(dialog).getByRole("button", { name: "Apply" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(applyCalls(v)).toHaveLength(1));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(v.getByRole("dialog")).toBeTruthy();
    release();
    await waitFor(() => expect(v.queryByRole("dialog")).toBeNull());
    expect(applyCalls(v)).toHaveLength(1);
  });

  it("shows conflicts from a failed apply", async () => {
    const v = setup({
      write: true,
      handlers: { "worktree.apply": () => ({ ok: false, strategy: "squash", conflicts: ["src/a.ts"], message: "resolve by hand" }) },
    });
    const dialog = await openApply(v);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await v.findByText(/stopped on conflicts: src\/a\.ts\. resolve by hand/);
  });

  it("blocks writes until session.get answers", async () => {
    const v = setup({ write: true, handlers: { "session.get": () => new Promise(() => {}) } });
    await openDiff(v);
    expect((v.getByRole("button", { name: "Apply…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(v.getByText(/Checking whether the session/)).toBeTruthy();
  });

  it("says plainly when a seat has no worktree", async () => {
    const v = setup({
      write: true,
      handlers: {
        "worktree.diff": () => {
          throw new Error("Invalid params: no worktree for that session and seat");
        },
      },
    });
    fireEvent.click(v.getByRole("button", { name: /Diff & worktrees/ }));
    fireEvent.click((await v.findAllByRole("button", { name: "View diff" }))[0]!);
    expect((await v.findByRole("alert")).textContent).toBe("No worktree for this seat.");
  });

  it("refuses an apply when only the diff text changed", async () => {
    let n = 0;
    const v = setup({
      write: true,
      handlers: {
        "worktree.diff": () => ({ baseSha: "abcdef0123", head: "0123abcdef", dirty: false, files: ["src/a.ts", "src/b.ts"], diff: ++n > 1 ? `${DIFF}\n+more` : DIFF, truncated: false }),
      },
    });
    const dialog = await openApply(v);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/changed since/);
    expect(applyCalls(v)).toHaveLength(0);
  });

  it("reloads the diff once the session stops being live", async () => {
    let gets = 0;
    let diffs = 0;
    const v = setup({
      write: true,
      handlers: {
        "session.get": () => ({ session: { id: sessionFixture.id, title: "t", hasLiveLog: true, lastSeq: 1, ...(++gets === 1 ? { live: "running" as const } : {}) }, pendingApprovals: [] }),
        "worktree.diff": () => ({ baseSha: "abcdef0123", head: "0123abcdef", dirty: false, files: ["src/a.ts"], diff: `${DIFF}\n${++diffs}`, truncated: false }),
      },
    });
    await openDiff(v);
    await v.findByText(/session is running/);
    expect(diffs).toBe(1);
    const last = sessionFixture.events.at(-1)!;
    act(() => {
      v.store.getState().applyEvents(sessionFixture.id, [{ ...last, seq: last.seq + 1, type: "session.state", data: { to: "STOPPED_FOR_TEST" } } as never]);
    });
    await waitFor(() => expect(diffs).toBe(2));
  });

  it("opens the worktree of the seat named by &seat= in a diff link", async () => {
    window.location.hash = "#/sessions?diff=src%2Fb.ts&seat=reviewer-1";
    try {
      const asked: unknown[] = [];
      const v = setup({
        handlers: {
          "worktree.diff": (p) => {
            asked.push(p);
            return { baseSha: "abcdef0123", head: "0123abcdef", dirty: false, files: ["src/a.ts", "src/b.ts"], diff: DIFF, truncated: false };
          },
        },
      });
      await v.findByRole("button", { name: "src/b.ts", pressed: true });
      expect(asked).toEqual([{ sessionId: sessionFixture.id, seatId: "reviewer-1" }]);
    } finally {
      window.location.hash = "";
    }
  });

  it("opens at the file named by a #/sessions?diff= link", async () => {
    window.location.hash = "#/sessions?diff=src%2Fb.ts";
    try {
      const v = setup();
      await v.findByRole("button", { name: "src/b.ts", pressed: true });
      expect(v.getByRole("heading", { name: "src/b.ts" })).toBeTruthy();
      expect(v.queryByRole("heading", { name: "src/a.ts" })).toBeNull();
    } finally {
      window.location.hash = "";
    }
  });
});
