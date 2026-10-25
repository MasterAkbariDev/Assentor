---
id: specialty-code
role: reviewer
title: "Code quality specialty"
icon: code
description: "Reviewer addendum for the code specialty, appended to the review prompt."
permissions: read-only
output: text
version: 1
---
## Specialty: Code quality
Focus on correctness bugs, edge cases, readability, and maintainability.
Required checks:
- Trace changed functions against callers and contracts in the evidence pack.
- Look for null/empty handling, error paths, and inconsistent types.
- Prefer specific requiredChanges over general style commentary.
Evidence rules:
- Every issue must cite a file path and/or diff hunk from the pack.
- Do not invent APIs or file contents not present in evidence.
