// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { renderWithStore } from "../../test/render.js";
import { PromptsView } from "./PromptsView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const summary = (id: string, source: "builtin" | "user" | "project", overridden = false) => ({ id, title: `Title ${id}`, role: "reviewer" as const, source, overridden });
const detail = (id: string, source: "builtin" | "user" | "project" = "builtin") => ({
  id, title: `Title ${id}`, role: "reviewer" as const, source,
  frontMatter: { id, role: "reviewer", title: `Title ${id}`, version: 2, variables: ["goal"], custom: "kept" },
  body: "Review {{goal}} now",
});

function setup(options: { canWrite?: boolean; validate?: (p: any) => any; preview?: (p: any) => any } = {}) {
  const transport = mockTransport({
    canWrite: options.canWrite,
    handlers: {
      "prompt.list": () => ({ prompts: [summary("alpha", "builtin"), summary("beta", "user", true)], errors: [{ file: "bad.md", message: "broken <b>x</b>" }] }),
      "prompt.get": (p) => detail(p!.id, p!.id === "beta" ? "user" : "builtin"),
      "prompt.validate": options.validate ?? (() => ({ ok: true, problems: [], variables: ["goal"], undeclared: [] })),
      "prompt.preview": options.preview ?? (() => ({ ok: true, text: "Review <i>x</i> now", missing: [] })),
      "prompt.save": (p) => ({ id: (p!.frontMatter as { id: string }).id, scope: p!.scope }),
      "prompt.fork": (p) => ({ id: p!.newId ?? p!.id, scope: p!.scope }),
    },
  });
  const r = renderWithStore(<PromptsView />, createEngineStore(), transport);
  return { ...r, mock: transport };
}
const calls = (m: ReturnType<typeof mockTransport>, method: string) => m.calls.filter((c) => c.method === method);

describe("PromptsView", () => {
  it("lists prompts with source badges and load errors as text", async () => {
    const { findByText, getByText, container } = setup();
    await findByText("Title alpha");
    expect(container.querySelector(".badge-builtin")?.textContent).toBe("builtin");
    expect(container.querySelector(".badge-user")?.textContent).toBe("user");
    expect(getByText("overrides")).toBeTruthy();
    expect(getByText("bad.md: broken <b>x</b>")).toBeTruthy();
  });

  it("opens the editor, validates inline and shows problems", async () => {
    let ok = true;
    const { findByText, findByLabelText, findByRole } = setup({
      validate: () => (ok ? { ok: true, problems: [], variables: ["goal"], undeclared: [] } : { ok: false, problems: ["role: bad"], variables: ["goal"], undeclared: ["extra"] }),
    });
    fireEvent.click(await findByText("Title alpha"));
    expect(((await findByLabelText("Body")) as HTMLTextAreaElement).value).toBe("Review {{goal}} now");
    await findByText("Valid.");
    ok = false;
    fireEvent.change(await findByLabelText("Title"), { target: { value: "Changed" } });
    expect(await findByText("role: bad")).toBeTruthy();
    expect((await findByRole("list", { name: "Validation problems" })).getAttribute("aria-label")).toBeTruthy();
    expect(await findByText(/not declared in variables: extra/)).toBeTruthy();
  });

  it("saves to the chosen scope with the complete front-matter, keeping unknown keys", async () => {
    const { findByText, findByLabelText, mock } = setup();
    fireEvent.click(await findByText("Title beta"));
    fireEvent.change(await findByLabelText("Body"), { target: { value: "new body" } });
    fireEvent.change(await findByLabelText("Save to"), { target: { value: "project" } });
    fireEvent.click(await findByText("Save"));
    await findByText("Saved beta to the project prompts.");
    expect(calls(mock, "prompt.save")[0]!.params).toMatchObject({
      scope: "project", body: "new body",
      frontMatter: { id: "beta", role: "reviewer", version: 2, variables: ["goal"], custom: "kept" },
    });
  });

  it("forks into a scope with an optional new id", async () => {
    const { findByText, findByLabelText, mock } = setup();
    fireEvent.click(await findByText("Title alpha"));
    fireEvent.change(await findByLabelText("Fork as id (optional)"), { target: { value: "alpha-copy" } });
    fireEvent.click(await findByText("Fork"));
    await findByText("Forked to alpha-copy in the user prompts.");
    expect(calls(mock, "prompt.fork")[0]!.params).toEqual({ id: "alpha", scope: "user", newId: "alpha-copy" });
  });

  it("previews with sample values and renders the result as text", async () => {
    const { findByText, findByLabelText, findByRole, mock, container } = setup();
    fireEvent.click(await findByText("Title alpha"));
    fireEvent.change(await findByLabelText("goal"), { target: { value: "ship it" } });
    fireEvent.click(await findByText("Preview"));
    expect((await findByRole("generic", { name: "Rendered prompt" })).textContent).toBe("Review <i>x</i> now");
    expect(container.querySelector("pre i")).toBeNull();
    expect(calls(mock, "prompt.preview")[0]!.params).toEqual({ id: "alpha", variables: { goal: "ship it" }, body: "Review {{goal}} now" });
  });

  it("disables write actions with a reason when the connection cannot write; reads still work", async () => {
    const { findByText, findByLabelText, getAllByText } = setup({ canWrite: false });
    fireEvent.click(await findByText("Title alpha"));
    await findByLabelText("Body");
    expect((await findByText("Save")).hasAttribute("disabled")).toBe(true);
    expect((await findByText("Fork")).hasAttribute("disabled")).toBe(true);
    expect((await findByText("New prompt")).hasAttribute("disabled")).toBe(true);
    expect(getAllByText(/read-only/).length).toBeGreaterThan(0);
    expect((await findByText("Save")).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("drops extends on load (no duplicated parent body), says so, and defaults the scope to the prompt's own", async () => {
    const transport = mockTransport({
      handlers: {
        "prompt.list": () => ({ prompts: [summary("kid", "project")], errors: [] }),
        "prompt.get": () => ({ ...detail("kid", "project"), frontMatter: { id: "kid", role: "reviewer", title: "Title kid", version: 1, extends: "alpha" } }),
        "prompt.validate": () => ({ ok: true, problems: [], variables: [], undeclared: [] }),
        "prompt.save": (p) => ({ id: "kid", scope: p!.scope }),
      },
    });
    const { findByText, findByLabelText } = renderWithStore(<PromptsView />, createEngineStore(), transport);
    fireEvent.click(await findByText("Title kid"));
    expect(await findByText(/extends alpha\. Saving writes a full copy/)).toBeTruthy();
    expect(((await findByLabelText("Extends (prompt id)")) as HTMLInputElement).value).toBe("");
    expect(((await findByLabelText("Save to")) as HTMLSelectElement).value).toBe("project");
    expect(((await findByLabelText("Body")) as HTMLTextAreaElement).maxLength).toBe(256 * 1024);
    fireEvent.click(await findByText("Save"));
    await findByText("Saved kid to the project prompts.");
    const saved = transport.calls.find((c) => c.method === "prompt.save")!.params as { frontMatter: Record<string, unknown> };
    expect(saved.frontMatter).not.toHaveProperty("extends");
  });

  it("offers Reset to built-in only as a disabled control with the reason", async () => {
    const { findByText } = setup();
    fireEvent.click(await findByText("Title beta"));
    expect((await findByText("Reset to built-in")).hasAttribute("disabled")).toBe(true);
    await findByText(/cannot delete prompt files yet/);
  });

  it("guards unsaved edits when switching prompts and on section links", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { findByText, findByLabelText } = setup();
    fireEvent.click(await findByText("Title alpha"));
    fireEvent.change(await findByLabelText("Body"), { target: { value: "edited" } });
    await findByText("unsaved changes");
    fireEvent.click(await findByText("Title beta"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(((await findByLabelText("Body")) as HTMLTextAreaElement).value).toBe("edited");

    const link = document.createElement("a");
    link.href = "#/teams";
    document.body.append(link);
    const notPrevented = link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(notPrevented).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);

    confirm.mockReturnValue(true);
    fireEvent.click(await findByText("Title beta"));
    await waitFor(() => expect((document.getElementById((document.querySelector("textarea") as HTMLTextAreaElement).id) as HTMLTextAreaElement).value).toBe("Review {{goal}} now"));
    link.remove();
  });
});
