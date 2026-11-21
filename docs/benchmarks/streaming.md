# Streaming perf harness (T05-02)

Question: can the real Session board keep up with 6 seats streaming events, and what coalescer interval should the desktop app use? This report covers the method, the development Chrome baseline, and measurements from the three native WebViews.

## Method

- **Fake engine** (`packages/ui/src/features/dev/perf/fakeEngine.ts`): `seats x rate x duration` real protocol events (`seat.output.delta`, `seat.status`, `seat.tokens`), seeded and deterministic, mixed per seat as 90% output, 5% status, 5% usage. Events go through `mockTransport.emit` -> `subscribe` -> `createFrameBatcher` -> the engine store -> the real `SessionBoard`. A 4 ms timer releases events that are due; if the main thread is busy they come out late and in bursts, as they would from a socket.
- **In-page metrics** (`perf/run.ts`, math in `perf/stats.ts`): frames per second and frame-interval percentiles from a `requestAnimationFrame` loop (janky = a frame over 33 ms); long tasks (`PerformanceObserver`, Chromium only); JS heap (`performance.memory`, Chromium only, sampled every 500 ms); coalescer: events pushed, store applies, average and max batch, longest wait from push to apply; emit lag (how far behind schedule the last event was). `complete` says whether the store ended with every event.
- **Page**: the dev fixtures page with `?perf=1` (not in the nav). Query: `seats`, `rate` (events/s per seat), `duration` (s, one number), `coalesce` (`raf` or a ms interval), `seed`, `autorun=1`. Comma lists run every combination. Results show in a table, **Export JSON** saves them, and `window.__perfResults` holds them for automation.
- **Serve it**: `pnpm perf:streaming` builds the UI with `VITE_PERF=1` (production React, harness included; a normal build still leaves the page out) and serves it on `127.0.0.1:4173`, printing the sweep URLs. `pnpm dev` of the UI also has the page.
- No browser automation is installed in the repo, so there is no headless sweep script; the runs below were driven by hand-written URLs.
- The first 300 ms after the board mounts are not measured (first paint and style recalculation otherwise show up as one 1.3 s frame in the first case).
- **Repeats**: every case ran 3 times (`repeat=3`); tables give the **median (min–max)** over the 3 runs. n=3 is still a small sample: treat differences inside the ranges as noise. The harness also exports this summary (`summary` in the JSON).
- **Driver**: a throwaway Chrome DevTools-protocol script (not committed; no automation tool is installed in the repo) launched headless Google Chrome, ran a discarded warm-up page (a fresh headless Chrome throttles its first seconds of frames), then loaded each sweep URL once.
- **Coalescer fix**: an earlier version of these numbers was discarded. `createFrameBatcher.flush()` left the previously armed timer/rAF alive, so a manual flush started a second chain and timer modes ran about twice as fast as configured (501 applies in 5 s at 16 ms). The batcher now cancels the pending callback on `flush()` and ignores stale ones; there are tests for both. All numbers below are after the fix.

## Numbers: this Mac (headless Google Chrome 156, macOS, 60 Hz, production build)

All rows: median (min–max) of n=3 runs of 5 s each, 6 seats unless stated. Rate is events/s per seat. Every run delivered every event (`complete`). fps is capped at 60 by the display; "max frame" is the longest requestAnimationFrame interval.

### Event rate (coalescer on rAF, the app's default)

| ev/s/seat | total ev/s | fps | max frame ms | janky frames | long tasks | heap peak MB | applies / 5 s | avg / max batch | max wait ms |
|---|---|---|---|---|---|---|---|---|---|
| 25 | 150 | 60 (53–60) | 16.8 (16.8–599.9) | 0 (0–1) | 0 | 5.7 (5.1–7.8) | 301 (267–301) | 2.5 (2.5–2.8) / 6 (6–91) | 17.6 (17.1–600.8) |
| 50 | 300 | 60 | 16.8 | 0 | 0 | 8 (6.7–8.3) | 301 (301–302) | 5 / 7 (6–7) | 17.1 (17–17.3) |
| 100 | 600 | 60 | 16.8 | 0 | 0 | 10 (9.5–10.3) | 302 | 10 / 13 | 17.3 (16.9–17.3) |
| 250 | 1,500 | 60 | 16.8 | 0 | 0 | 17.6 (11.9–18) | 302 | 24.9 / 32 (31–32) | 17.1 (16.8–17.1) |
| 500 | 3,000 | 60 | 16.8 | 0 | 0 | 35.3 (29.7–35.7) | 302 | 49.7 / 63 (63–64) | 17.3 (17.1–17.3) |
| 1000 | 6,000 | 59 (56–59.8) | 33.3 (33.3–66.7) | 0 (0–6) | 0 (0–1) | 62.1 (48.2–63.2) | 297 (280–300) | 101 (100–107.2) / 170 (166–353) | 24.9 (24.2–55.6) |
| 2000 | 12,000 | 28.8 (26.7–33.1) | 1099.9 (700–1216.6) | 11 (7–12) | 9 (8–10) | 101.5 (92–110.4) | 164 (161–166) | 365.9 (361.5–372.7) / 1000 | 339.8 (321.7–368.4) |

Up to 500 ev/s per seat (3,000 ev/s total) every run held 60 fps with no long tasks; the one outlier in the 25/s row (a 600 ms frame in one run, fps 53) is a stall in that single run, not a trend. At 1000/s (6,000 total) frames start to slip (median 59, worst run 56; one run had a long task). At 2000/s (12,000 total) the page is overloaded: ~29 fps, ~9 long tasks per run, a 1.1 s worst frame, and the fake engine falls 0.5 to 3.3 s behind its schedule. The card's target, 6 seats at ~50/s, is 300 events/s, a tenth of the comfortable ceiling.

### Coalescer interval

| ev/s/seat | interval | fps | max frame ms | janky frames | long tasks | heap peak MB | applies / 5 s | avg / max batch | max wait ms |
|---|---|---|---|---|---|---|---|---|---|
| 250 | rAF | 60 | 16.8 | 0 | 0 | 14.4 (11.9–15.4) | 302 (301–302) | 24.9 / 32 (32–44) | 17.1 (17.1–17.2) |
| 250 | 16 ms | 60 | 16.8 | 0 | 0 | 17.4 (16.6–18.7) | 251 | 29.9 / 33 (32–33) | 18 (17.9–18.1) |
| 250 | 33 ms | 60 | 16.8 | 0 | 0 | 32.8 (28.9–33.8) | 127 | 59.1 / 62 (62–63) | 38 (38–38.2) |
| 250 | 50 ms | 60 | 16.8 | 0 | 0 | 32.2 (30–32.6) | 91 | 82.5 / 90 (90–91) | 54.5 (54.4–54.7) |
| 250 | 100 ms | 60 | 16.8 | 0 | 0 | 29.9 (29.5–30.4) | 49 | 153.2 / 164 | 105.7 (105.3–105.9) |
| 1000 | rAF | 56.6 (52.8–57.4) | 66.8 (50–233.3) | 5 (4–5) | 1 (0–4) | 63.6 (54.6–73.8) | 284 (255–289) | 105.7 (103.8–117.7) / 359 (257–1000) | 56.9 (44.9–331.4) |
| 1000 | 16 ms | 59.6 (59.4–60) | 33.4 (16.8–33.4) | 1 (0–1) | 0 | 69.1 (63.9–83.5) | 242 (235–246) | 124 (122–127.7) / 389 (258–392) | 59 (53.1–62.6) |
| 1000 | 33 ms | 57.1 (50.3–57.2) | 116.7 (66.6–116.7) | 4 (3–13) | 3 (1–11) | 77.6 (38.8–91.9) | 118 (107–119) | 254.3 (252.2–280.4) / 1000 (716–1000) | 175.4 (110.3–204.5) |
| 1000 | 50 ms | 59.6 (50.6–60) | 33.4 (16.8–216.6) | 0 (0–8) | 0 (0–8) | 75.4 (50.6–77) | 88 (77–89) | 341 (337.1–389.7) / 538 (499–1000) | 105.2 (82.6–294.5) |
| 1000 | 100 ms | 56.5 (53–57) | 100 (66.7–166.7) | 5 (3–10) | 4 (2–8) | 56.6 (41–58.6) | 47 (46–47) | 638.4 (638.4–652.3) / 1000 | 233.3 (183.8–260) |

At 250/s per seat (1,500 total) every interval gives 60 fps with no jank, so the choice only matters at stress rates. At 1000/s per seat: rAF (56.6 fps) and a 16 ms timer (59.6) were best and about equal within the ranges, with the 16 ms timer slightly steadier (1 janky frame vs 5, no long task in the median). Longer intervals (33, 50, 100 ms) were not better and often worse (more janky frames and long tasks), because each apply then renders a bigger batch (250 to 640 events on average) and hits `MAX_PENDING_EVENTS` (max batch 1000). They also add 35 to 100+ ms of latency for no gain. 50 ms at 1000/s had one bad run (max frame 217 ms) and two good ones: n=3 cannot separate it from 16 ms with confidence.

### Seat count (50 ev/s per seat; the board has no virtualization, one card per seat)

| seats | total ev/s | fps | max frame ms | janky frames | long tasks | heap peak MB | applies / 5 s | avg / max batch | max wait ms |
|---|---|---|---|---|---|---|---|---|---|
| 6 | 300 | 60 | 16.8 | 0 | 0 | 7.2 (5.3–7.6) | 302 (301–302) | 5 / 7 (6–8) | 17.3 (17.3–17.4) |
| 24 | 1,200 | 60 | 16.8 | 0 | 0 | 16.4 (9.7–17.6) | 302 | 19.9 / 25 (25–26) | 16.1 (16–16.1) |
| 48 | 2,400 | 60 | 16.8 | 0 | 0 | 33.6 (26.4–36.9) | 302 | 39.9 / 51 (51–52) | 14.8 (14.8–15) |
| 96 | 4,800 | 56.4 (55.4–57.8) | 66.7 (66.7–66.8) | 5 (2–8) | 1 | 55.9 (47.2–57.6) | 276 (272–282) | 87.3 (85.4–88.6) / 353 (327–369) | 47.4 (36.3–49.6) |

Measured limit of the un-virtualized board: 48 seats (2,400 ev/s) is clean at 60 fps; 96 seats (4,800 ev/s) drops to ~56 fps with a few janky frames and a long task. The limit follows total event rate, in line with the rate table. Real runs have far fewer than 48 seats, so **the board does not need list virtualization**. Long lists inside the seat drawer (output history, activity) were **not** measured (n/a: the harness mounts the board only).

### Findings

- Heap grows with events received (about 1 to 2 KB per event: 30,000 events took the peak to ~62 MB at 1000/s, ~100 MB at 2000/s). The store keeps every event; a long run at high rates keeps growing. Worth a cap or windowing before T05 ships; not changed here.
- The apply cost grows with accumulated events: at 2000/s the long tasks are seconds, which lower rates never show.
- Heap numbers are noisy (GC timing); use the peak.
- Single browser, single machine, n=3: nothing here is a WebKit or Windows number.

## Recommendation

- **Coalescer interval: 16 ms** (one timer tick, about one frame), which is what the rAF default already does on desktop. It was never worse than rAF in the data above and was the steadier of the two at 6,000 ev/s. Do not lengthen it to save work: 33 to 100 ms were equal or worse at stress rates and add latency. This Chrome baseline covers three repeats per case. The native WebView results below inform the desktop recommendation.
- Keep `MAX_PENDING_EVENTS` at 1,000.
- Do not virtualize the Session board (6 seats is tiny; 48 is fine). Revisit if seat counts above ~50 become real.
- Treat ~3,000 events/s total (6 x 500) as the comfortable ceiling on this Mac; the webview rows below decide whether it is lower on Windows and Linux.

## Native Tauri WebViews

The native Tauri fixture uses the production React Session board and a
synthetic engine. The Windows measurements are recorded below. On November 21,
2026, GitHub Actions ran the same 21 cases three times in WKWebView on macOS
ARM64 and in WebKitGTK on Linux x64 under Xvfb. All 63 runs on each platform
applied their full event stream. CI also sampled process CPU time and summed
resident memory for about four seconds at six seats and 500 events/s per seat.
Host and WebView processes can share memory pages. Linux process CPU time
is reported at one-second resolution. Native CI hardware, rendering setup,
and window dimensions differ from the Windows host.
[macOS and Linux benchmark logs](https://github.com/MasterAkbariDev/Assentor/actions/runs/44934566820). A subsequent run also verified the bundled engine's RPC response over native IPC inside each WebView. [Native IPC fixture](https://github.com/MasterAkbariDev/Assentor/actions/runs/44935100399)

| Platform | FPS at 6 × 50 | FPS at 6 × 500 | FPS at 6 × 1,000 | CPU cores at 6 × 500 | Summed memory |
|---|---:|---:|---:|---:|---:|
| macOS WKWebView | 60.0 | 58.6 | 55.7 | ~0.85 | 327 MiB |
| Linux WebKitGTK under Xvfb | 38.4 | 31.5 | 30.6 | ~2.50 | 713 MiB |
| Windows WebView2 | 357–360 in rate sweep | 357–360 in rate sweep | 357–360 in rate sweep | ~0.49 | 452 MiB |

FPS describes animation callback cadence. Values in the macOS and Linux
columns are the median of three five-second runs with rAF coalescing. The
reported CPU and memory come from a separate 12-second case.

Keep rAF and the existing hidden-window fallback. On macOS, at 1,000
events/s per seat, the coalescer sweep recorded 58.7 fps and 40 ms median
maximum batch wait for rAF. At the same rate on Linux, the 100 ms timer
raised median callback cadence from 30.0 to 43.6 fps and increased maximum
batch wait from 52 to 108 ms. Linux CI performance warrants profiling on a
hardware-accelerated desktop before expanding beyond six seats. At 50
events/s per seat, Linux fell from 36.4 fps at six seats to 21.1 at twelve.
macOS and Windows showed no consistent drop through twelve seats. Keep the
current unvirtualized board for normal session sizes.

### Windows x64 / WebView2 157, November 21, 2026

The native Tauri preview displayed the production benchmark build in a visible
580 × 360 CSS-pixel webview. Each of the 21 synthetic cases ran for five
seconds, three times. All 63 runs applied their full event stream. The table
reports the medians of the three runs for each case.

| Sweep | Range | Observed rAF cadence | Frame interval p95 |
|---|---|---:|---:|
| Rate with six seats and rAF coalescing | 25–1,000 events/s/seat | 357–360 fps | 2.9 ms |
| Coalescer with six seats | 250 and 1,000 events/s/seat, rAF and 16–100 ms timers | 356–360 fps | 2.9 ms |
| Seat count at 50 events/s/seat | 6–48 seats | 357–360 fps | 2.9 ms |
| Seat count at 50 events/s/seat | 96 seats | 284 fps | 5.6 ms |

At 1,000 events/s/seat, the median of the maximum batch waits was 8.3 ms with
rAF and 21.8–110.4 ms with the timer settings. At six seats and 500 events/s/seat,
the median peak JavaScript heap was 31.3 MB. In a separate 12-second run at
that rate, six WebView2 processes used a combined 1.97 CPU seconds over the
4.03-second sample and had a 452 MiB summed working set, which can count
shared pages more than once. This was about 2.4% of the 20-logical-core host.
The harness counts animation frame callbacks, so FPS describes callback cadence.
