# Assentor web UI (`ui/`)

Watch-only browser view of Assentor runs, served by `assentor serve` (T04-03p). Vite + React 18 + TypeScript + Zustand. Plain CSS with variables (light/dark/system); no CSS framework yet.

```bash
pnpm build:ui          # → ui/dist, served by `assentor serve`
pnpm test              # UI tests run with the rest (jsdom per file)
```

## Layout

| Path | What |
|---|---|
| `src/main.tsx` | Entry: reads the token, starts the controller, renders `<App>`. |
| `src/App.tsx` | Shell: header (connection status, theme), session list, `SessionPanel` (heading, error and empty states; renders `features/session-board/`). |
| `src/engine/controller.ts` | `EngineController`: handshake, `sessions.list` refresh, one live subscription for the selected session, reconnect with backoff and resubscribe from `lastSeq`. |
| `src/store/engineStore.ts` | Zustand vanilla store (`createEngineStore`) + `createFrameBatcher` (applies events once per animation frame). |
| `src/store/context.tsx` | `<EngineStoreProvider>` and `useEngine(selector)`. |
| `src/store/selectors.ts` | Named selectors (`selectSeats`, `isLiveSeat`) and `groupSeats` (executor, reviewers, other). |
| `src/features/session-board/` | Read-only session board: `SessionBoard` (grid and the one elapsed ticker, `useNow`), `SeatCard`. |
| `src/transport/websocket.ts` | `connectWebSocket(url, token)` → `RpcClientTransport` (auth handshake first). |
| `src/transport/token.ts` | Takes `#token=…` from the URL, keeps it in sessionStorage, strips it from the address bar. |
| `src/test/` | Test helpers: `fixtures.ts` (realistic event stream), `renderWithStore`, in-process engine. |

## Engine imports

Import engine code only through `@engine/…` and only browser-safe modules:
`@engine/rpc/browser.js` (client + contract), `@engine/protocol/*`, `@engine/ui-shared/status.js` (`reduceSeatEvents`, `seatLineModel`, `STATUS_META`). Never `@engine/rpc/index.js` or anything that imports `node:*`.

## State

`useEngine((s) => s.session?.seats)` — seat map from `reduceSeatEvents`, the same reducer the TUI uses. Select narrowly: a component re-renders only when its selected value changes. `session.lastSeq` is the last applied event; the controller resubscribes from it.

## Session board

`features/session-board/` shows the selected run's seats as cards. It reads `useEngine(selectSeats)` and nothing else. The board is read-only: cards have no handlers and there are no buttons.

- **Groups:** executor first, then reviewers (`reviewer-*` and `panel`), then other seats. Each group has a title and a count.
- **Grid:** one column below 640px, two below 1024px, three above.
- **Card:** the status icon and label from `seatLineModel` / `STATUS_META` (the icon is decorative, the label is text), the name, model and role, the line (`detail` or `lastLine`, monospace, one line with an ellipsis), elapsed time, and tokens when either count is above zero.
- **Ticker:** the board owns the only elapsed-time ticker, `useNow(1000, live)`, and passes `now` to every card. It runs only while a seat is neither `done` nor `failed`.
- **Motion:** only a `thinking` icon animates, and only under `prefers-reduced-motion: no-preference`.
- **Not yet:** stages (no stage data on the engine yet, so there is no stage rail), model changes, pause, resume, cancel and the seat drawer.

## Writing a screen test

```tsx
// @vitest-environment jsdom
import { renderWithStore } from "../test/render.js";
import { sessionFixture } from "../test/fixtures.js";

const { store, getByText } = renderWithStore(<SessionPanel />);
store.getState().select(sessionFixture.id);
store.getState().applyEvents(sessionFixture.id, sessionFixture.events);
```

## Rules

- `serve`'s CSP allows no inline scripts and no inline `<style>` blocks; use CSS classes in `styles.css`.
- Never log or render the token.
- Keep the UI read-only until write methods exist on the engine.
