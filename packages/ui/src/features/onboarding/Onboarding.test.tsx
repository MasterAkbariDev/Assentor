// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { App } from "../../App.js";
import { createEngineStore } from "../../store/engineStore.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport } from "../../transport/mock.js";
import { Onboarding, ONBOARDING_KEY } from "./Onboarding.js";

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

function connected() {
  const store = createEngineStore();
  store.getState().setConnection("connected", "test");
  return store;
}

describe("Onboarding", () => {
  it("walks the steps and finishes", async () => {
    const { getByRole, getByText, queryByRole, container } = renderWithStore(<Onboarding />, connected(), mockTransport());
    expect(getByRole("heading", { name: "Set up Assentor" })).toBeTruthy();
    expect((getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Next" }));
    fireEvent.click(getByRole("button", { name: "Next" }));
    fireEvent.click(getByRole("button", { name: "Next" }));
    expect(getByText(/You are set/)).toBeTruthy();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Done");
    fireEvent.click(getByRole("button", { name: "Finish" }));
    expect(queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
    expect(container.textContent).toBe("");
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe("1");
  });

  it("stays hidden after a skip, across mounts", async () => {
    const first = renderWithStore(<Onboarding />, connected(), mockTransport());
    fireEvent.click(first.getByRole("button", { name: "Skip setup" }));
    expect(first.queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
    first.unmount();
    const second = renderWithStore(<Onboarding />, connected(), mockTransport());
    expect(second.queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
  });

  it("disables Detect CLIs without write access", async () => {
    const transport = mockTransport({ handlers: { "engine.hello": () => ({ engineVersion: "t", protocolVersion: 1, capabilities: ["sessions.list"] }) } });
    const { getByRole, findByText } = renderWithStore(<Onboarding />, connected(), transport);
    await findByText(/Read-only connection/);
    expect((getByRole("button", { name: "Detect CLIs" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is shown on the sessions view when there are no runs", async () => {
    const { getByRole, getByText, unmount } = renderWithStore(<App />, connected(), mockTransport());
    expect(getByText("Select a run to watch it live.")).toBeTruthy();
    expect(getByRole("heading", { name: "Set up Assentor" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Skip setup" }));
    unmount();
  });
});
