// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { createEngineStore } from "../../store/engineStore.js";
import { mockTransport } from "../../transport/mock.js";
import { renderWithStore } from "../../test/render.js";
import { PlaybooksView } from "./PlaybooksView.js";

afterEach(() => cleanup());

describe("PlaybooksView", () => {
  it("lists playbooks and shows stages in order with their links, read-only even without writes", async () => {
    const transport = mockTransport({
      canWrite: false,
      handlers: {
        "playbook.list": () => ({ playbooks: [{ id: "pb", title: "Ship <it>", description: "d", readOnly: true, source: "builtin", overridden: false }], errors: [{ file: "x.yaml", message: "bad" }] }),
        "playbook.get": () => ({
          id: "pb", title: "Ship <it>", description: "Do the thing", readOnly: true, source: "builtin", overridden: false,
          teams: { t1: { description: "team one", seats: [{ provider: "mock", model: "AUTO", role: "engineer", count: 2, permissions: "edit" }] } },
          stages: [
            { id: "build", kind: "execute", team: "t1", options: {}, requireApproval: false, next: "review" },
            { id: "review", kind: "review", options: { depth: 2 }, requireApproval: true, onNeedsWork: "build" },
          ],
        }),
      },
    });
    const { findByText, findByLabelText, getByText, container } = renderWithStore(<PlaybooksView />, createEngineStore(), transport);
    expect(await findByText("x.yaml: bad", { exact: false })).toBeTruthy();
    fireEvent.click(await findByText("Ship <it>"));
    const stages = (await findByLabelText("Stages")).querySelectorAll("li");
    expect([...stages].map((li) => li.querySelector("strong")?.textContent)).toEqual(["build", "review"]);
    expect(getByText(/needs approval/).textContent).toContain("on needs-work build");
    expect(getByText(/2 × mock AUTO/)).toBeTruthy();
    expect(container.querySelector("button[disabled]")).toBeNull();
    expect(transport.calls.map((c) => c.method)).toEqual(["playbook.list", "playbook.get"]);
  });
});
