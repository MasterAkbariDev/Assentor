import { useEffect, useRef, useState } from "react";
import type { EngineStore } from "../../../store/engineStore.js";
import { EngineStoreProvider } from "../../../store/context.js";
import { SessionBoard } from "../../session-board/SessionBoard.js";
import { measureCase, supports, type CaseResult } from "./run.js";
import { parsePerfParams } from "./stats.js";
import { summarizeRuns, type CaseSummary } from "./summary.js";

/**
 * Dev-only streaming perf harness (T05-02), inside `#/dev/fixtures?perf=1&seats=6&rate=50&duration=10`
 * (comma lists on seats, rate and coalesce run every combination). A fake engine feeds the real
 * mock transport, frame batcher, store and Session board; results show here, export as JSON, and
 * sit on `window.__perfResults` for automation.
 */

declare global {
  interface Window {
    __perfResults?: { done: boolean; userAgent: string; supports: ReturnType<typeof supports>; results: CaseResult[]; summary: CaseSummary[]; error?: string };
  }
}

function hashQuery(): string {
  const hash = window.location.hash;
  return hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
}

export function PerfHarness() {
  const [params, paramError] = (() => {
    try {
      return [parsePerfParams(hashQuery()), ""] as const;
    } catch (e) {
      return [undefined, (e as Error).message] as const;
    }
  })();
  const [active, setActive] = useState<EngineStore | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CaseResult[]>([]);
  const started = useRef(false);

  const mount = async (store: EngineStore | null) => {
    setActive(store);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };

  const run = async () => {
    if (!params || running) return;
    setRunning(true);
    setResults([]);
    const out: CaseResult[] = [];
    const publish = (done: boolean, error?: string) => {
      window.__perfResults = { done, userAgent: navigator.userAgent, supports: supports(), results: [...out], summary: summarizeRuns(out), ...(error ? { error } : {}) };
    };
    publish(false);
    try {
      for (const c of params.cases) {
        for (let i = 0; i < params.repeat; i += 1) {
          out.push(await measureCase(c, params, mount));
          setResults([...out]);
          publish(false);
        }
      }
      publish(true);
    } catch (e) {
      publish(true, (e as Error).message);
    }
    setRunning(false);
  };

  useEffect(() => {
    if (params?.autorun && !started.current) {
      started.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  const json = () => JSON.stringify(window.__perfResults ?? { results }, null, 2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([json()], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `streaming-${Date.now()}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="perf-harness">
      <p>
        {params ? `${params.cases.length} case(s) x ${params.repeat} run(s) x ${params.durationMs / 1000}s, seed ${params.seed}. ` : ""}
        {paramError ? <span className="notice error">{paramError}</span> : null}
        <button type="button" onClick={() => void run()} disabled={!params || running}>{running ? "Running…" : "Run"}</button>{" "}
        <button type="button" onClick={download} disabled={results.length === 0}>Export JSON</button>
      </p>
      {document.hidden ? <p className="notice warn">Tab is hidden: animation frames are paused, so fps is meaningless.</p> : null}
      <table>
        <thead>
          <tr><th>seats</th><th>ev/s/seat</th><th>coalesce</th><th>fps</th><th>p95 ms</th><th>max ms</th><th>janky</th><th>long tasks</th><th>heap MB</th><th>batch avg/max</th><th>wait ms</th><th>lag ms</th><th>events</th></tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i}>
              <td>{r.case.seats}</td><td>{r.case.rate}</td><td>{r.case.coalesce === "raf" ? "raf" : `${r.case.coalesce} ms`}</td>
              <td>{r.frames.fps.toFixed(1)}</td><td>{r.frames.p95.toFixed(1)}</td><td>{r.frames.max.toFixed(0)}</td><td>{r.frames.janky}</td>
              <td>{r.longTasks ? `${r.longTasks.count} (${r.longTasks.totalMs.toFixed(0)} ms)` : "n/a"}</td>
              <td>{r.heap ? `${r.heap.startMb}→${r.heap.endMb} (peak ${r.heap.peakMb})` : "n/a"}</td>
              <td>{r.coalescer.avgBatch}/{r.coalescer.maxBatch}</td><td>{r.coalescer.maxWaitMs}</td><td>{r.maxEmitLagMs}</td>
              <td>{r.complete ? "all" : "MISSING"} {r.applied}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {active ? (
        <EngineStoreProvider store={active}>
          <SessionBoard />
        </EngineStoreProvider>
      ) : null}
    </div>
  );
}
