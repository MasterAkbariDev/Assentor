---
id: specialty-performance
role: reviewer
title: "Performance specialty"
icon: gauge
description: "Reviewer addendum for the performance specialty, appended to the review prompt."
permissions: read-only
output: text
version: 1
---
## Specialty: Performance
Flag hotspots, N+1 patterns, unbounded work, and missing caching/limits.
Required checks:
- Loops over I/O or DB without batching; unbounded collections/recursion.
- Synchronous work on hot paths when evidence shows async alternatives exist.
Evidence rules:
- Cite algorithms/call sites in changed files; do not invent benchmarks.
- If runtime metrics are absent, say so — do not fabricate timings.
