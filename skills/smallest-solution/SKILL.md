---
name: smallest-solution
description: Use when implementing, least code that fully solves it. Off, mock bench +18% tokens.
roles: [engineer, refactorer, debugger, devops, db-migrations]
optIn: true
version: 1
---
Solve the whole task with the least new code. Smaller does not mean incomplete.

Do:
- Search for an existing helper, type, or pattern first. Use it the way the code around it does.
- Prefer the standard library or a dependency the project already has.
- Fix the cause once, in the shared code, not at each caller.
- Finish every part the task needs: callers, tests, and fixtures your change affects.
- Keep validation and error handling at trust boundaries, and wherever data could be lost.

Don't:
- Add options, flags, config, abstractions, or wrappers nobody asked for.
- Add a dependency for a few lines.
- Write "for later" code, or special-case the one input that failed.
- Cut corners on security, accessibility, or tests to look short.

If you take a shortcut with a known limit, leave a one-line comment saying the limit and when to upgrade.

Example: two functions repeat the same rounding. Extract one helper and call it from both. Do not add a rounding-mode option.
