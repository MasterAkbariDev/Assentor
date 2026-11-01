// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createEngineStore } from "../../store/engineStore.js";
import { renderWithStore } from "../../test/render.js";
import { mockTransport, type MockTransportOptions } from "../../transport/mock.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(() => cleanup());

type Handlers = NonNullable<MockTransportOptions["handlers"]>;

const SETTINGS = {
  executor: { provider: "claude-code", model: "AUTO" },
  run: { autonomy: "supervised" as const },
  routing: { strategy: "BALANCED" as const, reviewStrategy: "ADAPTIVE" as const },
  limits: { maxRounds: 3, maxMessages: 40, maxRuntimeMinutes: 60, maxToolCalls: 200 },
  git: { checkpoints: true, autoCommit: false },
  artifacts: { diff: true, tests: true, logs: false, screenshots: false },
};

/** Keys carry only id, provider, name and health: the RPC never returns a secret. */
const KEYS = [{ id: "3f9a0c11", provider: "openai", name: "team-key", healthy: true }];

/** The settings page on a connected link; `writable` decides whether `engine.hello` lists the write methods. */
function renderSettings(writable: boolean, handlers: Handlers = {}) {
  const transport = mockTransport({
    handlers: {
      "engine.hello": () => ({
        engineVersion: "test",
        protocolVersion: 1,
        capabilities: writable
          ? ["settings.get", "settings.save", "env.doctor", "env.detectClis"]
          : ["settings.get", "sessions.list"],
      }),
      "settings.get": () => ({ settings: structuredClone(SETTINGS), keys: KEYS }),
      ...handlers,
    },
  });
  const store = createEngineStore();
  store.getState().setConnection("connected", "test");
  return renderWithStore(<SettingsPage />, store, transport);
}

describe("SettingsPage: form", () => {
  it("loads the saved settings into the form", async () => {
    const { findByLabelText, getByLabelText, getByRole } = renderSettings(true);
    expect(((await findByLabelText("Max rounds")) as HTMLInputElement).value).toBe("3");
    expect((getByLabelText("Provider") as HTMLSelectElement).value).toBe("claude-code");
    expect((getByLabelText("Model") as HTMLInputElement).value).toBe("AUTO");
    expect((getByRole("radio", { name: "Supervised" }) as HTMLInputElement).checked).toBe(true);
  });

  it("saves only the changed fields and confirms", async () => {
    const { findByLabelText, getByRole, transport, findByText } = renderSettings(true, {
      "settings.save": () => ({ settings: { ...SETTINGS, limits: { ...SETTINGS.limits, maxRounds: 5 } } }),
    });
    fireEvent.change(await findByLabelText("Max rounds"), { target: { value: "5" } });
    fireEvent.click(getByRole("button", { name: "Save settings" }));
    await findByText("Settings saved");
    const saves = (transport as ReturnType<typeof mockTransport>).calls.filter((c) => c.method === "settings.save");
    expect(saves).toEqual([{ method: "settings.save", params: { settings: { limits: { maxRounds: 5 } } } }]);
  });

  it("shows validation errors and does not save an invalid form", async () => {
    const { findByLabelText, getByRole, findByText, transport } = renderSettings(true);
    const rounds = (await findByLabelText("Max rounds")) as HTMLInputElement;
    fireEvent.change(rounds, { target: { value: "0" } });
    const error = await findByText("Max rounds: enter a whole number of at least 1.");
    expect(rounds.getAttribute("aria-invalid")).toBe("true");
    expect(rounds.getAttribute("aria-describedby")).toBe("settings-maxRounds-error");
    expect(error.id).toBe("settings-maxRounds-error");
    expect((getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    expect((transport as ReturnType<typeof mockTransport>).calls.some((c) => c.method === "settings.save")).toBe(false);
  });

  it("refuses to clear a model that is set", async () => {
    const { findByLabelText, findByText } = renderSettings(true);
    fireEvent.change(await findByLabelText("Model"), { target: { value: "" } });
    await findByText(/Type AUTO to use the provider's default/);
  });

  it("shows a save error from the engine as text", async () => {
    const { findByLabelText, getByRole, findByRole } = renderSettings(true, {
      "settings.save": () => {
        throw new Error("Invalid settings: limits.maxRounds must be positive");
      },
    });
    fireEvent.change(await findByLabelText("Max messages"), { target: { value: "9" } });
    fireEvent.click(getByRole("button", { name: "Save settings" }));
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Invalid settings: limits.maxRounds must be positive");
  });
});

describe("SettingsPage: keys and secrets", () => {
  it("lists keys by provider and name, with no secret field anywhere", async () => {
    const { findByText, container } = renderSettings(true);
    await findByText("team-key");
    expect(container.textContent).toContain("openai");
    expect(container.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(container.querySelectorAll("textarea").length).toBe(0);
    const controls = Array.from(container.querySelectorAll<HTMLInputElement>("input, select"));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const labels = Array.from(control.labels ?? []).map((label) => label.textContent ?? "");
      expect([control.id, ...labels].join(" ")).not.toMatch(/key|secret|token/i);
      expect(control.value).not.toMatch(/sk-|secret/i);
    }
  });
});

describe("SettingsPage: diagnostics", () => {
  it("renders doctor results as text with their status and fix hint", async () => {
    const { findByRole, getByRole, findByText, getByText } = renderSettings(true, {
      "env.doctor": () => ({
        items: [
          { name: "git", ok: true, detail: "git 2.45" },
          { name: "claude-code", ok: false, detail: "Install the claude CLI, then run `claude` once." },
        ],
      }),
    });
    await findByRole("button", { name: "Run doctor" });
    fireEvent.click(getByRole("button", { name: "Run doctor" }));
    await findByText("Needs attention");
    expect(getByText("Install the claude CLI, then run `claude` once.")).toBeTruthy();
    expect(getByText("OK")).toBeTruthy();
  });

  it("lists detected CLIs with a copy button for the login command", async () => {
    const { findByRole, getByRole, findByText, getByText } = renderSettings(true, {
      "env.detectClis": () => ({
        clis: [{ id: "claude-code", name: "Claude Code", installed: true, available: true, version: "1.2.0", authenticated: false }],
      }),
    });
    await findByRole("button", { name: "Detect CLIs" });
    fireEvent.click(getByRole("button", { name: "Detect CLIs" }));
    await findByText("Not logged in");
    expect(getByText("claude")).toBeTruthy();
    expect(getByRole("button", { name: "Copy login command" })).toBeTruthy();
  });
});

describe("SettingsPage: without write access", () => {
  it("disables every write control and says why", async () => {
    const { findAllByText, getByRole } = renderSettings(false);
    const reasons = await findAllByText(/Read-only connection/);
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect((getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole("button", { name: "Run doctor" }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole("button", { name: "Detect CLIs" }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByRole("button", { name: "Save settings" }).getAttribute("aria-describedby")).toBe("save-hint");
  });

  it("does not run diagnostics or save even when a form change is made", async () => {
    const { findByLabelText, getByRole, transport } = renderSettings(false);
    fireEvent.change(await findByLabelText("Max rounds"), { target: { value: "7" } });
    await act(async () => {
      fireEvent.submit(getByRole("button", { name: "Save settings" }).closest("form")!);
    });
    const methods = (transport as ReturnType<typeof mockTransport>).calls.map((c) => c.method);
    expect(methods).not.toContain("settings.save");
    expect(methods).not.toContain("env.doctor");
  });
});
