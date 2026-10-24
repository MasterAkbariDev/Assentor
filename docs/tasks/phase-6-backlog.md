# Phase 6 — Backlog (not yet detailed)

Promote an item to a full card (see [templates.md §4](./templates.md)) when it's scheduled.

| ID | Title | Proposed tier | Why that tier | Notes |
|---|---|---|---|---|
| T06-01 | Model scoreboard (negotiation wins, review precision) feeding `AUTO` routing | 🟡 S (data) + 🔴 O (routing change) | Changes model choice for every run | Store in `~/.assentor/scoreboard.json`; precision = findings later confirmed fixed |
| T06-02 | Session export to Markdown/HTML report | 🟢 H | Pure rendering from event log | Include decision, dissent, diffs summary, costs; redact secrets |
| T06-03 | `assentor review --pr <n>` + GitHub Action | 🟡 S, review O | CI tokens are secrets | Read-only seats only; posts review comment |
| T06-04 | MCP server mode (`negotiate`, `review` tools) | 🔴 O | New network/IPC surface | stdio MCP first |
| T06-05 | User-defined CLI provider recipes (`~/.assentor/providers/*.yaml`) | 🔴 O | Runs arbitrary binaries with flags | Validate, never allow bypass flags on read-only seats |
| T06-06 | Unify executor recipes and reviewer CLI adapters | 🔴 O | Touches permission flags for every CLI | Removes duplicate arg builders noted in README §7 |
| T06-07 | Flatpak / `.rpm` packages | 🟡 S | Packaging only | After T05-11 |
| T06-08 | i18n of UI strings | 🟢 H | Mechanical | Extract strings first |
