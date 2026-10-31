import { useMemo, useState } from "react";
import { parseEngineEvent, type EngineEvent } from "#assentor/protocol/events.js";
import { SessionPanel } from "../../App.js";
import { EngineStoreProvider } from "../../store/context.js";
import { createEngineStore } from "../../store/engineStore.js";
import { leadFixture, negotiationFixture, sessionFixture } from "../../test/fixtures.js";
import ndjson from "../../../fixtures/session-negotiate-review.ndjson?raw";

/** Dev-only (`#/dev/fixtures`): replay a recorded stream into a private store and scrub through it. */

const FIXTURES: Record<string, { id: string; events: EngineEvent[] }> = {
  "negotiate + review (ndjson)": (() => {
    const events = ndjson.trim().split("\n").map((line) => parseEngineEvent(JSON.parse(line)));
    return { id: events[0]!.sessionId, events };
  })(),
  "executor + reviewers": sessionFixture,
  "negotiation (debate, vote)": negotiationFixture,
  "lead board": leadFixture,
};

export default function FixturesPage() {
  const [name, setName] = useState(Object.keys(FIXTURES)[0]!);
  const fixture = FIXTURES[name]!;
  const [count, setCount] = useState<number | undefined>(undefined);
  const applied = Math.min(count ?? fixture.events.length, fixture.events.length);
  // A fresh store per (fixture, position): scrubbing is the same as a reload at that point.
  const store = useMemo(() => {
    const s = createEngineStore();
    s.getState().select(fixture.id);
    s.getState().setSessions([{ id: fixture.id, title: name, hasLiveLog: true, lastSeq: applied }]);
    s.getState().applyEvents(fixture.id, fixture.events.slice(0, applied));
    return s;
  }, [fixture, name, applied]);

  return (
    <section aria-label="Fixtures">
      <h1 className="session-heading">Fixtures (dev only)</h1>
      <div className="fixture-controls">
        <label>
          Stream{" "}
          <select value={name} onChange={(e) => { setName(e.target.value); setCount(undefined); }}>
            {Object.keys(FIXTURES).map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label>
          Events applied: {applied} / {fixture.events.length}{" "}
          <input type="range" min={0} max={fixture.events.length} value={applied} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
      </div>
      <EngineStoreProvider store={store}>
        <SessionPanel />
      </EngineStoreProvider>
    </section>
  );
}
