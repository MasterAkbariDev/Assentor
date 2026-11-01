// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { RpcRemoteError } from "#assentor/protocol/rpc-client.js";
import { RpcErrorCode } from "#assentor/protocol/rpc.js";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { renderWithStore } from "../../test/render.js";
import { TeamsView } from "./TeamsView.js";

afterEach(() => cleanup());

const seat = (n: number, role = "code-reviewer") => ({
  id: `opus-${n}`, displayName: `Opus#${n}`, provider: "claude-code" as const, transport: "cli" as const, model: "opus", role, permissions: "read-only" as const,
});

function setup(options: { canWrite?: boolean; problems?: string[]; deleteError?: RpcRemoteError } = {}) {
  const transport = mockTransport({
    canWrite: options.canWrite,
    handlers: {
      "team.list": () => ({
        teams: [{ name: "panel", description: "Review panel", source: "config", seats: [seat(1), seat(2), seat(3), seat(4, "security-reviewer")] }],
        modes: { review: "panel" },
      }),
      "prompt.list": () => ({ prompts: [{ id: "code-reviewer", title: "CR", role: "reviewer", source: "builtin", overridden: false }, { id: "security-reviewer", title: "SR", role: "reviewer", source: "builtin", overridden: false }], errors: [] }),
      "models.catalog": () => ({ entries: [{ id: "opus", label: "Opus", source: "seed" }] }),
      "team.validate": () => ({ ok: !options.problems, problems: options.problems ?? [] }),
      "team.save": (p) => ({ name: p!.name }),
      "team.delete": async (p) => {
        if (options.deleteError) throw options.deleteError;
        return { name: p!.name };
      },
    },
  });
  return { ...renderWithStore(<TeamsView />, createEngineStore(), transport), mock: transport };
}
const calls = (m: ReturnType<typeof mockTransport>, method: string) => m.calls.filter((c) => c.method === method);

describe("TeamsView", () => {
  it("loads a team into a seat table, folding equal seats into a count, with the mode it serves", async () => {
    const { findByText, findByLabelText } = setup();
    expect(await findByText("review mode")).toBeTruthy();
    fireEvent.click(await findByText("panel"));
    expect(((await findByLabelText("Count, seat 1")) as HTMLInputElement).value).toBe("3");
    expect(((await findByLabelText("Role, seat 2")) as HTMLSelectElement).value).toBe("security-reviewer");
    expect((await findByText("opus#1…#3")).textContent).toBeTruthy();
  });

  it("bounds the count to 1..8", async () => {
    const { findByText, findByLabelText } = setup();
    fireEvent.click(await findByText("panel"));
    const count = (await findByLabelText("Count, seat 1")) as HTMLInputElement;
    fireEvent.change(count, { target: { value: "99" } });
    expect(count.value).toBe("8");
    expect((await findByLabelText("More, seat 1")).hasAttribute("disabled")).toBe(true);
    fireEvent.change(count, { target: { value: "0" } });
    expect(count.value).toBe("1");
    expect((await findByLabelText("Fewer, seat 1")).hasAttribute("disabled")).toBe(true);
  });

  it("validates inline, announcing the problems", async () => {
    const { findByText, findByRole } = setup({ problems: ["seats.0.model: unknown"] });
    fireEvent.click(await findByText("panel"));
    expect(await findByText("seats.0.model: unknown")).toBeTruthy();
    expect(await findByRole("list", { name: "Validation problems" })).toBeTruthy();
  });

  it("saves the edited team through team.save", async () => {
    const { findByText, findByLabelText, mock } = setup();
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByLabelText("More, seat 1"));
    fireEvent.click(await findByText("Save"));
    await findByText("Saved team panel.");
    expect(calls(mock, "team.save")[0]!.params).toEqual({
      name: "panel",
      team: {
        description: "Review panel",
        seats: [
          { provider: "claude-code", transport: "cli", model: "opus", role: "code-reviewer", count: 4, permissions: "read-only" },
          { provider: "claude-code", transport: "cli", model: "opus", role: "security-reviewer", count: 1, permissions: "read-only" },
        ],
      },
    });
  });

  it("creates a new team and saves it", async () => {
    const { findByText, findByLabelText, mock } = setup();
    fireEvent.click(await findByText("New team"));
    fireEvent.change(await findByLabelText("Name"), { target: { value: "solo" } });
    fireEvent.click(await findByText("Save"));
    await findByText("Saved team solo.");
    expect(calls(mock, "team.save")[0]!.params).toMatchObject({ name: "solo", team: { seats: [{ provider: "mock", model: "AUTO", count: 1 }] } });
  });

  it("disables save and delete with a reason when the connection cannot write", async () => {
    const { findByText, getByText } = setup({ canWrite: false });
    fireEvent.click(await findByText("panel"));
    expect((await findByText("Save")).hasAttribute("disabled")).toBe(true);
    expect((await findByText("Delete")).hasAttribute("disabled")).toBe(true);
    expect((await findByText("Delete")).getAttribute("aria-describedby")).toBeTruthy();
    expect(getByText(/This connection is read-only/)).toBeTruthy();
  });

  it("deletes after a confirmation step, and shows the references that block a delete", async () => {
    const blocked = new RpcRemoteError({ code: RpcErrorCode.InvalidParams, message: "Team panel is still used by modes.review.team", data: { references: ["modes.review.team", "playbook p stage s1"] } });
    const { findByText, findByRole } = setup({ deleteError: blocked });
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByText("Delete"));
    fireEvent.click(await findByText("Confirm delete panel"));
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("still used by modes.review.team");
    expect(alert.textContent).toContain("playbook p stage s1");
  });

  it("deletes a free team and clears the editor", async () => {
    const { findByText, mock } = setup();
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByText("Delete"));
    fireEvent.click(await findByText("Confirm delete panel"));
    await findByText("Deleted team panel.");
    expect(calls(mock, "team.delete")[0]!.params).toEqual({ name: "panel" });
  });
});
