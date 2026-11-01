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

const SPEC = {
  description: "Review panel",
  seats: [
    { provider: "claude-code" as const, transport: "cli" as const, model: "opus", role: "code-reviewer", count: 3, permissions: "read-only" as const, promptRef: "my-cr" },
    { provider: "claude-code" as const, model: "opus", role: "security-reviewer", count: 1, permissions: "edit" as const, name: "Sec", budget: { maxTokens: 1000 } },
  ],
};

function setup(options: { canWrite?: boolean; problems?: string[]; deleteError?: RpcRemoteError } = {}) {
  const transport = mockTransport({
    canWrite: options.canWrite,
    handlers: {
      "team.list": () => ({
        teams: [
          { name: "panel", description: "Review panel", source: "config", seats: [seat(1), seat(2), seat(3), seat(4, "security-reviewer")], spec: SPEC },
          { name: "legacy-review", description: "Reviewers from config.reviewers", source: "legacy-review", seats: [seat(1)] },
        ],
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
    expect(((await findByLabelText("Transport, seat 2")) as HTMLSelectElement).value).toBe(""); // no explicit transport added
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

  it("saving an unchanged team writes an identical spec (promptRef, name and budget kept, no folding)", async () => {
    const { findByText, mock } = setup();
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByText("Save"));
    await findByText("Saved team panel.");
    expect(calls(mock, "team.save")[0]!.params).toEqual({ name: "panel", team: SPEC });
  });

  it("saves an edit through team.save, changing only what was edited", async () => {
    const { findByText, findByLabelText, mock } = setup();
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByLabelText("More, seat 1"));
    fireEvent.click(await findByText("Save"));
    await findByText("Saved team panel.");
    expect(calls(mock, "team.save")[0]!.params).toEqual({
      name: "panel",
      team: { ...SPEC, seats: [{ ...SPEC.seats[0], count: 4 }, SPEC.seats[1]] },
    });
  });

  it("shows a team without a spec (legacy-review) read-only", async () => {
    const { findByText, findByLabelText } = setup();
    fireEvent.click(await findByText("legacy-review", { selector: ".lib-item-title" }));
    expect(await findByText(/cannot be edited here/)).toBeTruthy();
    expect((await findByLabelText("Model, seat 1")).matches(":disabled")).toBe(true); // via the disabled fieldset
    expect((await findByText("Save")).matches(":disabled")).toBe(true);
  });

  it("checks the new team name live and blocks Save until it is kebab-case", async () => {
    const { findByText, findByLabelText, findByRole } = setup();
    fireEvent.click(await findByText("New team"));
    const name = await findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Bad Name" } });
    expect((await findByRole("alert")).textContent).toMatch(/kebab-case/);
    expect((await findByText("Save")).hasAttribute("disabled")).toBe(true);
    fireEvent.change(name, { target: { value: "good-name" } });
    expect((await findByText("Save")).hasAttribute("disabled")).toBe(false);
  });

  it("keeps keyboard focus when Delete turns into Confirm and back", async () => {
    const { findByText } = setup();
    fireEvent.click(await findByText("panel"));
    fireEvent.click(await findByText("Delete"));
    expect(document.activeElement).toBe(await findByText("Confirm delete panel"));
    fireEvent.click(await findByText("Cancel"));
    expect(document.activeElement).toBe(await findByText("Delete"));
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
