# Streaming perf harness (T05-02)

Question: can the real Session board keep up with 6 seats streaming events, and what coalescer interval should the desktop app use? This file holds the method, the numbers measured on the dev Mac, and what the owner still has to run in the three production webviews.

## Method

- **Fake engine** (`packages/ui/src/features/dev/perf/fakeEngine.ts`): `seats x rate x duration` real protocol events (`seat.output.delta`, `seat.status`, `seat.tokens`), seeded and deterministic, mixed per seat as 90% output, 5% status, 5% usage. Events go through `mockTransport.emit` -> `subscribe` -> `createFrameBatcher` -> the engine store -> the real `SessionBoard`. A 4 ms timer releases events that are due; if the main thread is busy they come out late and in bursts, as they would from a socket.
- **In-page metrics** (`perf/run.ts`, math in `perf/stats.ts`): frames per second and frame-interval percentiles from a `requestAnimationFrame` loop (janky = a frame over 33 ms); long tasks (`PerformanceObserver`, Chromium only); JS heap (`performance.memory`, Chromium only, sampled every 500 ms); coalescer: events pushed, store applies, average and max batch, longest wait from push to apply; emit lag (how far behind schedule the last event was). `complete` says whether the store ended with every event.
- **Page**: the dev fixtures page with `?perf=1` (not in the nav). Query: `seats`, `rate` (events/s per seat), `duration` (s, one number), `coalesce` (`raf` or a ms interval), `seed`, `autorun=1`. Comma lists run every combination. Results show in a table, **Export JSON** saves them, and `window.__perfResults` holds them for automation.
- **Serve it**: `pnpm perf:streaming` builds the UI with `VITE_PERF=1` (production React, harness included; a normal build still leaves the page out) and serves it on `127.0.0.1:4173`, printing the sweep URLs. `pnpm dev` of the UI also has the page.
- No browser automation is installed in the repo, so there is no headless sweep script; the runs below were driven by hand-written URLs.
- The first 300 ms after the board mounts are not measured (first paint and style recalculation otherwise show up as one 1.3 s frame in the first case).

## Numbers: this Mac (headless Chromium 156, macOS, 60 Hz, production build)

6 seats, 5 s per case, coalescer on `requestAnimationFrame` (the app's default). Rate is events/s per seat, so total = 6 x rate.

| ev/s/seat | total ev/s | fps | frame p95 ms | max frame ms | janky | long tasks | heap peak MB | avg / max batch | max wait ms |
|---|---|---|---|---|---|---|---|---|---|
| 25 | 150 | 60.0 | 18.5 | 19 | 0 | 0 | 8.4 | 2.5 / 6 | 17.7 |
| 50 | 300 | 60.0 | 18.3 | 19 | 0 | 0 | 7.0 | 5 / 7 | 17.5 |
| 100 | 600 | 60.0 | 18.3 | 19 | 0 | 0 | 8.9 | 10 / 13 | 17.3 |
| 250 | 1,500 | 60.0 | 18.4 | 19 | 0 | 0 | 13.7 | 24.9 / 32 | 17.4 |
| 500 | 3,000 | 60.0 | 18.4 | 19 | 0 | 0 | 21.9 | 49.7 / 63 | 17.2 |
| 1000 | 6,000 | 57.6 | 18.6 | 51 | 5 | 0 | 36.0 | 104 / 294 | 44.4 |
| 2000 (one run, earlier build) | 12,000 | 28.5 | 67.5 | 1085 | 8 | 8 (5.7 s total, longest 3.4 s) | 110 | 380 / 1000 | 371; emit lag 2.7 s |

Every case delivered every event (`complete`). The target of the card, 6 seats at ~50 events/s, uses a few percent of a frame budget; the board only breaks past roughly 6,000 events/s in total.

### Coalescer interval (6 seats)

| ev/s/seat | interval | fps | max frame ms | janky | avg / max batch | max wait ms |
|---|---|---|---|---|---|---|
| 250 | rAF | 60.0 | 19 | 0 | 24.9 / 32 | 17.2 |
| 250 | 16 ms | 60.0 | 19 | 0 | 15 / 21 | 11.4 |
| 250 | 50 ms | 60.0 | 19 | 0 | 41.7 / 81 | 49.8 |
| 250 | 100 ms | 60.0 | 19 | 0 | 150 / 164 | 105 |
| 250 | 250 ms | 60.0 | 19 | 0 | 289 / 386 | 255 |
| 1000 | rAF | 58.0 | 68 | 3 | 103 / 332 | 51 (1 long task, 50 ms) |
| 1000 | 16 ms | 60.0 | 19 | 0 | 69 / 255 | 38 |
| 1000 | 50 ms | 60.0 | 19 | 0 | 169 / 322 | 50.5 |
| 1000 | 100 ms | 58.4 | 52 | 4 | 600 / 896 | 159 |
| 1000 | 250 ms | 60.0 | 19 | 0 | 333 / 1000 | 170 |

Reading: on this Mac the interval hardly matters up to 1,500 events/s. Under stress a timer of 16 to 50 ms beat rAF slightly; 100 ms did not (bigger batches mean bigger single renders). Note that `MAX_PENDING_EVENTS` (1,000) forces an early flush, which is why waits stay under the interval.

### Seat count (50 ev/s per seat; the board has no virtualization, one card per seat)

| seats | total ev/s | fps | max frame ms | janky | avg batch |
|---|---|---|---|---|---|
| 6 | 300 | 60.0 | 19 | 0 | 5 |
| 12 | 600 | 60.0 | 19 | 0 | 10 |
| 24 | 1,200 | 60.0 | 19 | 0 | 19.9 |
| 48 | 2,400 | 60.0 | 19 | 0 | 39.9 |
| 96 | 4,800 | 59.4 | 34 | 3 | 81.7 |

Measured limit for the un-virtualized board: 48 seats at 50/s is clean; 96 starts to drop frames (and that is mostly total event rate, in line with the table above). Real runs have far fewer than 48 seats, so **the board does not need list virtualization**. Virtualization of long lists inside the seat drawer (output history, activity) was **not** measured here: the harness mounts the board only.

### Findings

- Heap grows with events received (about 1 to 1.5 KB per event at the high rates: 30k events took the peak from ~15 MB to ~36 to 75 MB). The store keeps every event; a long run at high rates will keep growing. Worth a cap or windowing before T05 ships; not changed here.
- The apply cost grows with accumulated events: the 2000 ev/s case produced multi-second long tasks, which the lower rates never do.
- Heap numbers are noisy (GC timing); use peak, not end minus start.

## Recommendation

- Keep the frame batcher, with a **16 to 50 ms** floor between applies (rAF is fine on desktop Chromium; use a 33 ms timer as the fallback if a webview shows jank in its rAF row). Leave `MAX_PENDING_EVENTS` at 1,000.
- Do not virtualize the Session board (6 seats is tiny; 48 is fine). Revisit if seat counts above ~50 become real.
- Treat ~3,000 events/s total (6 x 500) as the comfortable ceiling for the dev Mac; the webview rows below decide whether it is lower on Windows and Linux.

## Owner must run: WKWebView, WebView2, WebKitGTK

Not measured here (no Tauri on this Mac; Safari/WKWebView and the other two engines were not run). On each OS, in a dev build of the desktop app or in the matching browser engine (Safari, Edge, Epiphany/GNOME Web as stand-ins):

1. `pnpm perf:streaming` (or `pnpm --filter @assentor/ui dev` and the same hash URL).
2. Open each URL it prints, with the window visible and in front (a hidden window pauses animation frames and the page warns about it). Close other heavy apps; plug in a laptop.
3. Run: the rate sweep (`rate=25,50,100,250,500,1000`), the coalescer sweep (`rate=250,1000&coalesce=raf,16,33,50,100`) and the seat sweep. Press **Export JSON** and attach the files here or paste the table under a dated heading per OS.
4. CPU is not measured in the page. While a `rate=500` case runs, note the webview process CPU in Activity Monitor / Task Manager / `top`, and the memory of the same process.
5. Long-task and heap columns show `n/a` in WebKit engines (no API); fps, frame percentiles and coalescer columns work everywhere.

| OS / webview | rate ceiling at 60 fps (6 seats) | best interval | CPU at 6 x 500 | notes |
|---|---|---|---|---|
| macOS / WKWebView | _owner_ | _owner_ | _owner_ | |
| Windows / WebView2 | _owner_ | _owner_ | _owner_ | |
| Linux / WebKitGTK | _owner_ | _owner_ | _owner_ | |
