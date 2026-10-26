// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { App } from "./App.js";
import { renderWithStore } from "./test/render.js";
import { sessionFixture } from "./test/fixtures.js";
import { takeToken } from "./transport/token.js";

afterEach(() => cleanup());

describe("App shell", () => {
  it("lists sessions, shows connection status, and renders seats for the selected run", () => {
    const { store, getByText, getByRole, queryByText } = renderWithStore(<App />);
    act(() => {
      store.getState().setConnection("connected", "0.4.0");
      store.getState().setSessions([
        { id: sessionFixture.id, title: "Implement average()", status: "DONE", hasLiveLog: true, lastSeq: 16 },
        { id: "old", title: "Old run", status: "DONE", hasLiveLog: false, lastSeq: 0 },
      ]);
    });
    expect(getByRole("status").textContent).toContain("Connected · engine 0.4.0");
    expect(getByText("Old run")).toBeTruthy();
    expect(queryByText("Select a run to watch it live.")).toBeTruthy();

    act(() => {
      getByText("Implement average()").click();
    });
    act(() => {
      store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
    });
    expect(getByText("Opus#2")).toBeTruthy();
    expect(getByText("failed")).toBeTruthy();
    expect(getByRole("heading").textContent).toContain("REVIEWING");
  });

  it("explains a missing token and an old run without a live log", () => {
    const { store, getByText } = renderWithStore(<App />);
    act(() => {
      store.getState().setConnection("no_token");
      store.getState().setSessions([{ id: "old", title: "Old run", hasLiveLog: false, lastSeq: 0 }]);
      store.getState().select("old");
    });
    expect(getByText(/Open the link printed by `assentor serve`/)).toBeTruthy();
    expect(getByText(/made before live logs existed/)).toBeTruthy();
  });
});

describe("takeToken", () => {
  it("reads the token from the fragment, keeps it for the tab and strips it from the URL", () => {
    window.history.replaceState(null, "", `/#token=${"c".repeat(64)}`);
    expect(takeToken()).toBe("c".repeat(64));
    expect(window.location.hash).toBe("");
    expect(takeToken()).toBe("c".repeat(64)); // from sessionStorage after the strip
  });
});
