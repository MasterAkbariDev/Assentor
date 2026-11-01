# Assentor web UI (`packages/ui/`)

Watch-only browser view of Assentor runs, served by `assentor serve` (T04-03p). Vite + React 18 + TypeScript + Zustand. Plain CSS with variables (light/dark/system); no CSS framework yet.

```bash
pnpm build:ui          # → packages/ui/dist, served by `assentor serve`
pnpm test              # UI tests run with the rest (jsdom per file)
```

## Layout

| Path | What |
|---|---|
| `src/main.tsx` | Entry: reads the token, starts the controller, renders `<App>`. |
| `src/App.tsx` | Shell: header (connection status, theme), sidebar (section nav + session list), `SessionPanel` (heading, error and empty states; renders `features/session-board/` and `features/seat-drawer/`). |
| `src/shell/` | `route.ts` (hash router, `SECTIONS`), `Sidebar.tsx` (`SectionNav`, `EmptySection`), `Toasts.tsx` (`ToastProvider`, `useToast`, connection toasts). |
| `src/features/dev/` | `FixturesPage`: `#/dev/fixtures`, dev builds only (not in the nav or the production bundle). |
| `src/engine/controller.ts` | `EngineController`: on each transport `open`: hello, `sessions.list` refresh, one live subscription for the selected session, resubscribe from `lastSeq`. |
| `src/store/engineStore.ts` | Zustand vanilla store (`createEngineStore`) + `createFrameBatcher` (applies events once per animation frame). |
| `src/store/context.tsx` | `<EngineStoreProvider>` and `useEngine(selector)`. |
| `src/store/selectors.ts` | Named selectors (`selectSeats`, `isLiveSeat`) and `groupSeats` (executor, reviewers, other). |
| `src/features/session-board/` | Session board: `SessionBoard` (grid and the one elapsed ticker, `useNow`), `SeatCard` (opens the drawer). |
| `src/features/usage/` | Usage section: `UsagePage` (the selected run from the sidebar list) and `UsagePanel` (totals, per seat / stage / model tables, budget bars). `usageModel.ts` holds the pure helpers. |
| `src/features/seat-drawer/` | Read-only seat drawer: `SeatDrawer` (panel, tabs, focus), `SeatActivity`, `SeatOutput`, `SeatInfo`, `activity.ts` (row text). |
| `src/transport/types.ts` | `Transport` (`call`, `subscribe`, `onStatus`, `close`): the single seam to the engine. |
| `src/transport/websocketTransport.ts` | `WebSocketTransport`: connects, reconnects with backoff, wraps the typed RPC client. |
| `src/transport/mock.ts` | `mockTransport()` for tests and the fixtures page. |
| `src/transport/context.tsx` | `<TransportProvider>` and `useRpc()`. |
| `src/transport/contract.test-suite.ts` | `runTransportContract(name, make)`: what every `Transport` must do. |
| `src/transport/websocket.ts` | `connectWebSocket(url, token)` → `RpcClientTransport` (auth handshake first). |
| `src/transport/token.ts` | Takes `#token=…` from the URL, keeps it in sessionStorage, strips it from the address bar. |
| `src/test/` | Test helpers: `fixtures.ts` (event streams), `render.tsx` (`renderWithStore`). |
| `fixtures/` | `session-negotiate-review.ndjson`: the generated negotiate + review stream (see Fixtures). |

## Transport and `useRpc()`

Components never touch a WebSocket. `useRpc()` returns the `Transport`:

```tsx
const rpc = useRpc();
const { sessions } = await rpc.call("sessions.list");      // typed by the protocol
const sub = await rpc.subscribe(id, lastSeq, { onEvent });  // seq > lastSeq, in order
const off = rpc.onStatus((s) => …);                         // called at once, then on change
```

Status: `connecting` → `open`; a lost link goes `reconnecting` → `open`; `unauthorized` and `closed` are final. Calls and subscribes reject while not `open`; a dropped link ends subscriptions, so resubscribe from the last `seq` on `open` (the `EngineController` does this for the store). A new transport (Tauri) implements `Transport` and calls `runTransportContract` from its own test file. Depend on `Transport`, not on a client class.

## Routing and shell

A tiny hash router (`shell/route.ts`): `#/sessions` (default), `#/prompts`, `#/teams`, `#/playbooks`, `#/usage`, `#/settings`. Prompts, Teams and Playbooks show an empty state until built. Settings is built (`features/settings/`): settings form, keys list, Doctor and CLI detection; the first-run guide (`features/onboarding/`) shows in the sessions view while there are no runs. TanStack Router, Query and Virtual, Radix and Tailwind are not in the approved dependency set (STATUS §6), so none are used. `useToast()` shows a toast; the shell toasts when the connection drops and returns.

## Engine imports

Import other workspace packages only through `#assentor/…` (aliased to their sources in `vite.config.ts`) and only browser-safe modules:
`#assentor/protocol/*` (contract), `#assentor/ui-shared/status.js` (`reduceSeatEvents`, `seatLineModel`, `STATUS_META`), `#assentor/protocol/rpc-client.js` (typed RPC client), and from the engine only `#assentor/engine/review/ranking.js`. Never `#assentor/engine/rpc/index.js` or anything that imports `node:*`.

## State

`useEngine((s) => s.session?.seats)` — seat map from `reduceSeatEvents`, the same reducer the TUI uses. Select narrowly: a component re-renders only when its selected value changes. `session.lastSeq` is the last applied event; the controller resubscribes from it.

## Session board

`features/session-board/` shows the selected run's seats as cards. It reads `useEngine(selectSeats)` and `openSeat`. Cards are `role="button"` elements: a click, Enter or Space opens the seat drawer. Nothing on the board changes the run.

- **Groups:** executor first, then reviewers (`reviewer-*` and `panel`), then other seats. Each group has a title and a count.
- **Grid:** one column below 640px, two below 1024px, three above.
- **Card:** the status icon and label from `seatLineModel` / `STATUS_META` (the icon is decorative, the label is text), the name, model and role, the line (`detail` or `lastLine`, monospace, one line with an ellipsis), elapsed time, and tokens when either count is above zero.
- **Ticker:** the board owns the only elapsed-time ticker, `useNow(1000, live)`, and passes `now` to every card. It runs only while a seat is neither `done` nor `failed`.
- **Motion:** only a `thinking` icon animates, and only under `prefers-reduced-motion: no-preference`.
- **Not yet:** stages (no stage data on the engine yet, so there is no stage rail), pause, resume, cancel, restart, inject, and the Files and Transcript views of the seat drawer.

## Seat drawer

`features/seat-drawer/` is a read-only panel for one seat. The store holds which seat is open (`openSeatId`, set by `openSeat`). `SessionPanel` mounts `<SeatDrawer />` next to the board, and `select` closes the drawer when the run changes.

- **Opening:** a card click, Enter or Space. The panel is a right-side `role="dialog"` named by the seat's name; below 640px it is full width.
- **Closing:** Escape, or the Close button. Focus returns to the card that opened it.
- **Tabs:** `role="tablist"` with `tab` and `tabpanel`. Arrow keys, Home and End move between tabs; only the selected tab is in the tab order.
- **Activity:** this seat's events from `seatEvents`, oldest first, one line each with local time: status changes (with detail), tool calls, done and failed, errors, retries, model changes and verdicts. Each row is plain text.
- **Output:** `outputTail` in a `<pre>` as plain text. It follows the end until the reader scrolls up; then "Jump to latest" appears.
- **Info:** provider, transport and permissions from `seatInfo` (`seat.spawned`), plus model, role, status, start and end times, elapsed time, tokens and the seat and session ids.
- **Store data:** `seatInfo` (from `seat.spawned`) and `seatEvents` (the last `SEAT_EVENT_CAP` = 200 non-`seat.output.delta` events per seat). Both are rebuilt identically on replay, like the rest of the session view.

## Usage

`#/usage` shows the run picked in the sidebar: totals (tokens in and out, cached share, cost, calls, retries), tables by seat, stage and model, and a budget bar for each budget that has passed its 50% warning (the report carries limits only through warnings). It reads `usage.get`, reloading 300 ms after the last `seat.tokens` of the run (`tokenEvents` in the store). Read-only. Not shown yet: estimate vs actual (no field in `UsageReport`) and skills loaded (no `skill.loaded` event in the protocol).

## Diff & worktrees

`features/diff/` (collapsed section under the run): one row per seat, "View diff" loads `worktree.diff`. Shows the complete file list, a per-file filter, collapsible hunks (plain text, never HTML), and a notice when the engine cut the diff at 512 KiB. Apply (strategy) and Discard (force) open a modal confirm listing the files and then send `confirm: true`. Both are disabled with a reason unless `engine.hello` capabilities include `worktree.apply` and `worktree.discard` (the connection has write access; the opt-in UI is T04-12), and while `session.get` reports the session live. Not built: Monaco side-by-side and two-candidate compare (no new dependency), branch and gate status (no RPC or event carries them).

## Writing a screen test

```tsx
// @vitest-environment jsdom
import { renderWithStore } from "../test/render.js";
import { sessionFixture } from "../test/fixtures.js";

const { store, getByText } = renderWithStore(<SessionPanel />);
act(() => {
  store.getState().select(sessionFixture.id);
  store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
});
```

`renderWithStore(ui, store?, transport?)` wraps `ui` in a fresh engine store, a `mockTransport()` and toasts, and returns the store and transport. `mockTransport({ sessions, handlers, engineVersion })` serves recorded events, records `calls`, and has `emit(event)` (live event) and `drop()` (link lost, then back). Selectors: read named ones from `store/selectors.ts` (`useEngine(selectSeats)`); select narrowly.

## Fixtures

`test/fixtures.ts` exports `sessionFixture`, `negotiationFixture`, `leadFixture`, `negotiateReviewFixture` and `burstFixture(seats, perSeat)`. `fixtures/session-negotiate-review.ndjson` is `negotiateReviewFixture` as one JSON event per line; `test/fixtures.test.ts` fails if they differ. Regenerate with `UPDATE_FIXTURES=1 npx vitest run packages/ui/src/test`. In a dev build, `#/dev/fixtures` replays any fixture into a private store with a slider for "reload at event N".

## Rules

- `serve`'s CSP allows no inline scripts and no inline `<style>` blocks; use CSS classes in `styles.css`.
- Never log or render the token.
- Keep the UI read-only until write methods exist on the engine.
