# Phase 6 — Backlog (not yet detailed)

Promote an item to a full card (see [templates.md §4](./templates.md)) when it's scheduled.

| ID | Title | Proposed tier | Why that tier | Notes |
|---|---|---|---|---|
| T06-01 | Model scoreboard (negotiation wins, review precision) feeding `AUTO` routing | 🟡 S (data) + 🔴 O (routing change) | Changes model choice for every run | Store in `~/.assentor/scoreboard.json`; precision = findings later confirmed fixed |
| T06-02 ✅ | Session export to Markdown report | 🟢 H | Pure rendering from event log | Done (`95edf9b` + `65fde20`, Haiku #2, Sonnet NEEDS_WORK → fixed): `assentor export <sessionId> [-p] [-o] [--force]`; every event value redacted, stripped of control/bidi characters, capped at 500 chars and put in a code span; no output text. HTML output and diff/cost sections not done. Follow-up: strip zero-width characters *before* redaction so they can't split a secret. |
| T06-03 | `assentor review --pr <n>` + GitHub Action | 🟡 S, review O | CI tokens are secrets | Read-only seats only; posts review comment |
| T06-04 | MCP server mode (`negotiate`, `review` tools) | 🔴 O | New network/IPC surface | stdio MCP first |
| T06-05 | User-defined CLI provider recipes (`~/.assentor/providers/*.yaml`) | 🔴 O | Runs arbitrary binaries with flags | Validate, never allow bypass flags on read-only seats |
| T06-06 | Unify executor recipes and reviewer CLI adapters | 🔴 O | Touches permission flags for every CLI | Removes duplicate arg builders noted in README §7 |
| T06-07 | Flatpak / `.rpm` packages | 🟡 S | Packaging only | After T05-11 |
| T06-08 | i18n of UI strings | 🟢 H | Mechanical | Extract strings first |
| T06-09 | Watch mode daemon (`assentor watch`, push/PR/CI/schedule triggers) | 🔴 O | Long-running processes, CI tokens | Read-only by default; see modes.md §6 |
| T06-10 | Interactive mode (team chat with `@seat` routing) | 🟡 S, review O | Needs Phase 4 UI + Lead routing | modes.md §6 |
| T06-11 | Scoreboard → Lead roster & Cascade tier tuning | 🟡 S, review O | Changes who gets hired | Builds on T06-01 + T02B-19 rows |
