---
name: test-triage
description: Use when tests fail, first error, rerun one test. Off, mock bench +17% tokens.
roles: [engineer, debugger, test-writer]
optIn: true
version: 1
---
Work from the first failure, not the whole output.

Do:
- Read the first error and its stack line in project code. Later failures are often caused by it.
- Open only the failing test and the code it calls.
- Rerun that single test (a file or name filter) after each change.
- Capture only the tail of a long run and the first error block.
- Run the full suite, typecheck, or build only when your role prompt asks for it, and quote their summary lines.

Don't:
- Paste whole logs or stack traces into your reply. Quote the one error line.
- Rerun the full suite after every small edit.
- Read every failing test before fixing the first one.
- "Fix" a test by weakening it. If the test is wrong, say why.
- Claim a pass you did not see. Quote the summary line.

Example: 14 tests fail. The first error is "TypeError: x is undefined" at src/price.ts:12. Fix that, rerun that one test, then see how many of the other 13 remain.
