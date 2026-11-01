// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { App } from "../../App.js";
import { createEngineStore } from "../../store/engineStore.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport } from "../../transport/mock.js";
import { Onboarding, ONBOARDING_KEY } from "./Onboarding.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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

  it("still shows and dismisses when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const { getByRole, queryByRole } = renderWithStore(<Onboarding />, connected(), mockTransport());
    expect(getByRole("heading", { name: "Set up Assentor" })).toBeTruthy();
    expect(() => fireEvent.click(getByRole("button", { name: "Skip setup" }))).not.toThrow();
    expect(queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
  });

  it("disables Detect CLIs without write access", async () => {
    const transport = mockTransport({ handlers: { "engine.hello": () => ({ engineVersion: "t", protocolVersion: 1, capabilities: ["sessions.list"] }) } });
    const { getByRole, findByText } = renderWithStore(<Onboarding />, connected(), transport);
    await findByText(/Read-only connection/);
    expect((getByRole("button", { name: "Detect CLIs" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is shown on the sessions view only once connected and the session list has loaded", async () => {
    const store = connected();
    const { getByRole, queryByRole, getByText, unmount } = renderWithStore(<App />, store, mockTransport());
    expect(getByText("Select a run to watch it live.")).toBeTruthy();
    expect(queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
    act(() => store.getState().setSessions([]));
    expect(getByRole("heading", { name: "Set up Assentor" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Skip setup" }));
    unmount();
  });

  it("is not shown while the link is not connected, even with the list loaded", async () => {
    const store = createEngineStore();
    store.getState().setSessions([]);
    const { queryByRole, unmount } = renderWithStore(<App />, store, mockTransport());
    expect(queryByRole("heading", { name: "Set up Assentor" })).toBeNull();
    unmount();
  });
});
