// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { EngineEvent } from "@engine/protocol/events.js";
import { renderWithStore } from "../../test/render.js";
import { SessionPanel } from "../../App.js";
import { findingsOf, groupByFile, type FindingEvent } from "./reviewModel.js";
import { ReviewView } from "./ReviewView.js";

afterEach(() => cleanup());

const SESSION = "11111111-2222-4333-8444-555555555555";

/** Events for one run, numbered and timed in order. Each draft is `{ type, seatId?, data }`. */
function stream(drafts: Array<Record<string, unknown>>): EngineEvent[] {
  return drafts.map(
    (draft, i) =>
      ({
        seq: i + 1,
        sessionId: SESSION,
        at: new Date(Date.UTC(2026, 9, 25, 10, 0, i)).toISOString(),
        ...draft,
      }) as EngineEvent,
  );
}

const spawn = (seatId: string, displayName: string, model: string, role: string) => ({
  type: "seat.spawned",
  seatId,
  data: { displayName, provider: "mock", transport: "api", model, role, permissions: "read-only" },
});

const finding = (key: string, description: string, severity: string, affectedFiles: string[], agreement?: { count: number; total: number }) => ({
  type: "review.finding",
  data: { key, description, severity, affectedFiles, ...(agreement ? { agreement } : {}) },
});

/** A panel of four reviewers (two answered) and four correlated findings. */
function panelStream(): EngineEvent[] {
  return stream([
    spawn("executor", "Executor", "AUTO", "engineer"),
    spawn("panel", "Review panel", "AUTO", "panel"),
    spawn("reviewer-1", "Opus#1", "claude-opus", "code-reviewer"),
    spawn("reviewer-2", "Opus#2", "claude-opus", "security-reviewer"),
    { type: "seat.done", seatId: "reviewer-1", data: { ok: true, summary: "Looks correct" } },
    { type: "seat.error", seatId: "reviewer-2", data: { message: "timed out" } },
    finding("f-readme", "Docs out of date", "minor", ["README.md"], { count: 1, total: 4 }),
    finding("f-auth", "Token compared with ==", "major", ["src/auth.ts"], { count: 3, total: 4 }),
    finding("f-crash", "Null dereference", "blocker", ["src/auth.ts", "src/session.ts"], { count: 4, total: 4 }),
    finding("f-general", "General concern", "info", [], { count: 2, total: 4 }),
    {
      type: "review.verdict",
      seatId: "panel",
      data: { status: "NEEDS_WORK", summary: "Panel [unanimous] Opus#1 PASS, Opus#2 NEEDS_WORK. Changes required", confidence: 0.8 },
    },
  ]);
}

function renderReview(events: EngineEvent[]) {
  const rendered = renderWithStore(<ReviewView />);
  act(() => {
    rendered.store.getState().select(SESSION);
    rendered.store.getState().applyEvents(SESSION, events);
  });
  return rendered;
}

describe("ReviewView grouping and ordering", () => {
  it("groups findings by first affected file, files in path order, no-file last, severity inside a file", () => {
    const { container, getByText } = renderReview(panelStream());
    const fileNames = Array.from(container.querySelectorAll(".review-file-name")).map((el) => el.textContent);
    expect(fileNames).toEqual(["README.md", "src/auth.ts", "No file named"]);

    const authGroup = getByText("src/auth.ts").closest("section") as HTMLElement;
    const authItems = within(authGroup).getAllByRole("listitem").map((li) => li.querySelector(".review-finding-text")?.textContent);
    expect(authItems).toEqual(["Null dereference", "Token compared with =="]);
    expect(within(authGroup).getByText("Also in: src/session.ts")).toBeTruthy();
  });

  it("ranks by severity, then agreement (most first), then key", () => {
    const findingEvents = stream([
      finding("b-key", "same severity, low agreement", "major", ["a.ts"], { count: 1, total: 4 }),
      finding("c-key", "same severity, high agreement", "major", ["a.ts"], { count: 3, total: 4 }),
      finding("a-key", "same severity, same agreement as c", "major", ["a.ts"], { count: 3, total: 4 }),
      finding("z-key", "more severe", "blocker", ["a.ts"], { count: 1, total: 4 }),
    ]) as FindingEvent[];
    const { findings } = findingsOf(findingEvents, undefined);
    expect(findings.map((f) => f.key)).toEqual(["z-key", "a-key", "c-key", "b-key"]);
    expect(groupByFile(findings)).toHaveLength(1);
  });

  it("renders the reviewer seats with status, model, role and the seat's detail", () => {
    const { container, getByText } = renderReview(panelStream());
    // The panel seat is a reviewer row too; it has no run yet.
    const rows = Array.from(container.querySelectorAll(".review-reviewer")).map((el) => el.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("queued");
    expect(rows[1]).toContain("done");
    expect(rows[1]).toContain("Opus#1");
    expect(rows[1]).toContain("claude-opus · code-reviewer");
    expect(rows[1]).toContain("Looks correct");
    expect(rows[2]).toContain("failed");
    expect(getByText("timed out")).toBeTruthy();
    expect(getByText(/per-reviewer verdict and confidence are not in the event stream/)).toBeTruthy();
  });
});

describe("ReviewView filters and agreement", () => {
  it("shows the agreement badge as count/total", () => {
    const { getByText, queryByText } = renderReview(panelStream());
    expect(getByText("4/4")).toBeTruthy();
    expect(getByText("3/4")).toBeTruthy();
    expect(getByText("1/4")).toBeTruthy();
    expect(getByText("2/4")).toBeTruthy();
    expect(queryByText("agreement not recorded")).toBeNull();
  });

  it("filters by severity through a labelled select and restores All", () => {
    const { getByLabelText, getByText, queryByText } = renderReview(panelStream());
    const select = getByLabelText("Severity") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "major" } });
    expect(getByText("Token compared with ==")).toBeTruthy();
    expect(queryByText("Null dereference")).toBeNull();
    expect(queryByText("Docs out of date")).toBeNull();

    fireEvent.change(select, { target: { value: "all" } });
    expect(getByText("Null dereference")).toBeTruthy();
    expect(getByText("Docs out of date")).toBeTruthy();
  });

  it("says when filters hide every finding", () => {
    const { getByLabelText, getByText } = renderReview(panelStream());
    fireEvent.change(getByLabelText("Severity"), { target: { value: "blocker" } });
    fireEvent.click(getByText("Only disagreements"));
    expect(getByText("No findings match these filters.")).toBeTruthy();
  });

  it("'only disagreements' is a switch that keeps partial agreement and drops full agreement", () => {
    const { getByRole, getByText, queryByText } = renderReview(panelStream());
    const toggle = getByRole("switch", { name: "Only disagreements" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(queryByText("Null dereference")).toBeNull(); // 4/4 is full agreement
    expect(getByText("Token compared with ==")).toBeTruthy(); // 3/4
    expect(getByText("Docs out of date")).toBeTruthy(); // 1/4
    expect(getByText("General concern")).toBeTruthy(); // 2/4

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getByText("Null dereference")).toBeTruthy();
  });

  it("without agreement data, 'only disagreements' is disabled, does nothing and is described by the note", () => {
    const { getByRole, getByText } = renderReview(
      stream([
        {
          type: "review.verdict",
          seatId: "panel",
          data: {
            status: "NEEDS_WORK",
            summary: "Two issues",
            issues: [
              {
                id: "I-1",
                severity: "major",
                category: "correctness",
                description: "Off by one",
                affectedFiles: ["a.ts"],
                evidence: ["a.ts:3"],
                requiredChange: "Use <= here",
              },
            ],
          },
        },
      ]),
    );
    expect(getByText("Use <= here")).toBeTruthy();
    expect(getByText("agreement not recorded")).toBeTruthy();
    const toggle = getByRole("switch", { name: "Only disagreements" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const note = getByText(/Agreement is not in the event stream/);
    expect(toggle.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.id).not.toBe("");
    // Focusable, but a click changes nothing and hides nothing.
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getByText("Off by one")).toBeTruthy();
  });

  it("clears the disagreements switch when agreement data goes away", () => {
    const { store, getByRole, getByText, queryByText } = renderWithStore(<ReviewView />);
    const withAgreement = [
      finding("f-a", "Has counts", "major", ["a.ts"], { count: 1, total: 4 }),
      finding("f-b", "Full counts", "minor", ["b.ts"], { count: 4, total: 4 }),
    ];
    act(() => {
      store.getState().select(SESSION);
      store.getState().applyEvents(SESSION, stream(withAgreement));
    });
    fireEvent.click(getByRole("switch", { name: "Only disagreements" }));
    expect(queryByText("Full counts")).toBeNull();

    // A new run with findings but no counts: the switch is cleared, not left on.
    act(() => {
      store.getState().select(undefined);
      store.getState().select(SESSION);
      store.getState().applyEvents(SESSION, stream([finding("f-c", "No counts", "major", ["c.ts"])]));
    });
    const toggle = getByRole("switch", { name: "Only disagreements" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(getByText("No counts")).toBeTruthy();
  });

  it("keeps an unknown severity as given, ranks it last, and filters it with 'other'", () => {
    const { getByLabelText, getByText, queryByText, container } = renderReview(
      stream([
        finding("f-info", "Known info", "info", ["a.ts"], { count: 1, total: 2 }),
        finding("f-odd", "Odd severity", "critical", ["a.ts"], { count: 1, total: 2 }),
      ]),
    );
    const descriptions = Array.from(container.querySelectorAll(".review-finding-text")).map((el) => el.textContent);
    expect(descriptions).toEqual(["Known info", "Odd severity"]);
    expect(getByText("critical")).toBeTruthy();
    fireEvent.change(getByLabelText("Severity"), { target: { value: "other" } });
    expect(getByText("Odd severity")).toBeTruthy();
    expect(queryByText("Known info")).toBeNull();
  });

  it("says how many issues could not be read and leaves them out", () => {
    const { getByText, queryByText } = renderReview(
      stream([
        {
          type: "review.verdict",
          seatId: "panel",
          data: {
            status: "NEEDS_WORK",
            summary: "x",
            issues: [
              { id: "I-1", severity: "major", description: "Readable issue", affectedFiles: ["a.ts"], evidence: [] },
              { severity: "major", description: "No id, so unreadable" },
            ],
          },
        },
      ]),
    );
    expect(getByText("Readable issue")).toBeTruthy();
    expect(queryByText("No id, so unreadable")).toBeNull();
    expect(getByText("1 issue could not be read.")).toBeTruthy();
  });
});

describe("ReviewView decision and safety", () => {
  it("announces the decision with its status, confidence, policy and summary", () => {
    const { getByRole } = renderReview(panelStream());
    const banner = getByRole("status");
    expect(banner.textContent).toContain("Decision: Needs work");
    expect(banner.textContent).toContain("confidence 0.8");
    expect(banner.textContent).toContain("Policy: unanimous");
    expect(banner.textContent).toContain("Panel [unanimous] Opus#1 PASS, Opus#2 NEEDS_WORK. Changes required");
  });

  it("says the policy does not apply to a single reviewer", () => {
    const { getByRole } = renderReview(
      stream([
        spawn("reviewer-1", "Opus#1", "claude-opus", "code-reviewer"),
        { type: "review.verdict", seatId: "reviewer-1", data: { status: "PASS", summary: "Looks fine" } },
      ]),
    );
    expect(getByRole("status").textContent).toContain("Policy: not applicable (single reviewer)");
  });

  it("says the policy is not recorded when the summary has no policy label", () => {
    const { getByRole } = renderReview(
      stream([{ type: "review.verdict", seatId: "panel", data: { status: "PASS", summary: "Panel: majority passed" } }]),
    );
    expect(getByRole("status").textContent).toContain("Policy: not recorded in the event stream");
  });

  it("ignores a verdict that has no seat (Lead's per-task verdict)", () => {
    const { store } = renderWithStore(<ReviewView />);
    act(() => {
      store.getState().select(SESSION);
      store.getState().applyEvents(SESSION, stream([{ type: "review.verdict", data: { status: "PASS", taskId: "t1" } }]));
    });
    expect(store.getState().session?.reviewVerdict).toBeUndefined();
  });

  it("renders finding text as text, never as HTML", () => {
    const { container, getByText } = renderReview(
      stream([finding("f-html", "<img src=x onerror=alert(1)> <b>bold</b>", "major", ["a.ts"], { count: 1, total: 2 })]),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(getByText("<img src=x onerror=alert(1)> <b>bold</b>")).toBeTruthy();
  });
});

describe("app shell", () => {
  it("shows the review only for a run with review events", () => {
    const executorOnly = renderWithStore(<SessionPanel />);
    act(() => {
      executorOnly.store.getState().select(SESSION);
      executorOnly.store.getState().applyEvents(SESSION, stream([spawn("executor", "Executor", "AUTO", "engineer")]));
    });
    expect(executorOnly.queryByRole("heading", { name: "Review" })).toBeNull();
    cleanup();

    const withReview = renderWithStore(<SessionPanel />);
    act(() => {
      withReview.store.getState().select(SESSION);
      withReview.store.getState().applyEvents(SESSION, panelStream());
    });
    expect(withReview.getByRole("heading", { name: "Review" })).toBeTruthy();
  });
});
