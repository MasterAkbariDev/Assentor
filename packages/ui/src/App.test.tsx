// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { renderWithStore } from "./test/render.js";
import { sessionFixture } from "./test/fixtures.js";
import { useRpc } from "./transport/context.js";
import { mockTransport } from "./transport/mock.js";
import { takeToken } from "./transport/token.js";

afterEach(() => cleanup());

describe("App shell", () => {
  it("lists sessions, shows connection status, and renders seats for the selected run", () => {
    const { store, getByText, getAllByText, getByRole, queryByText } = renderWithStore(<App />);
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
    // The board and the review view both name the reviewers.
    expect(getAllByText("Opus#2").length).toBeGreaterThan(0);
    expect(getAllByText("failed").length).toBeGreaterThan(0);
    expect(getByRole("heading", { level: 1 }).textContent).toContain("REVIEWING");
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

describe("sections and useRpc", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("lists every section, all built, and keeps Sessions the default", async () => {
    const { getByRole, getByText, queryByText } = renderWithStore(<App />);
    const nav = getByRole("navigation", { name: "Sections" });
    expect(Array.from(nav.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Sessions", "Prompts", "Teams", "Playbooks", "Usage", "Settings"]);
    expect(queryByText(/Not built yet/)).toBeNull();
    expect(getByText("Select a run to watch it live.")).toBeTruthy();

    act(() => {
      window.location.hash = "#/settings";
    });
    await waitFor(() => expect(getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page"));
    expect(queryByText("Select a run to watch it live.")).toBeNull();
  });

  it("keeps the dev fixtures page out of the nav", () => {
    const { getByRole } = renderWithStore(<App />);
    expect(getByRole("navigation", { name: "Sections" }).textContent).not.toMatch(/fixtures/i);
  });

  it("toasts when the connection drops and comes back", () => {
    const { store, getByText, getByRole } = renderWithStore(<App />);
    expect(getByRole("log", { name: "Notifications" })).toBeTruthy(); // always in the page, so announcements are heard
    act(() => store.getState().setConnection("connected"));
    act(() => store.getState().setConnection("reconnecting"));
    expect(getByRole("alert").textContent).toContain("Connection lost. Reconnecting…");
    act(() => store.getState().setConnection("connected"));
    expect(getByText("Reconnected.")).toBeTruthy();
  });

  it("useRpc gives components the transport", async () => {
    const transport = mockTransport({ engineVersion: "9.9" });
    function Version() {
      const rpc = useRpc();
      const [v, setV] = useState("");
      useEffect(() => void rpc.call("engine.hello").then((h) => setV(h.engineVersion)), [rpc]);
      return <p>{v}</p>;
    }
    const { findByText } = renderWithStore(<Version />, undefined, transport);
    expect(await findByText("9.9")).toBeTruthy();
  });

  it("renders the dev fixtures page and a mid-stream position", async () => {
    window.location.hash = "#/dev/fixtures";
    const { findByRole, findAllByText } = renderWithStore(<App />);
    expect(await findByRole("heading", { name: /Fixtures/ })).toBeTruthy();
    expect((await findAllByText("Opus#2")).length).toBeGreaterThan(0);
  });
});
