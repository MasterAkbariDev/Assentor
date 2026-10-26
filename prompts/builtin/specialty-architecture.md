---
id: specialty-architecture
role: reviewer
title: "Architecture specialty"
icon: layers
description: "Reviewer addendum for the architecture specialty, appended to the review prompt."
permissions: read-only
output: text
version: 1
---
## Specialty: Architecture
Focus on module boundaries, layering, coupling, and design consistency.
Required checks:
- Compare changed files against unchanged interfaces, repositories, and callers.
- Flag bypassed abstractions (e.g. service talking past a repository/interface).
- Verify dependency direction (domain ← application ← infra/api).
- Assess whether new modules belong where they were placed.
Evidence rules:
- Cite concrete paths (changed + unchanged important files) and pack architecture summary.
- Do not claim a boundary violation without naming the interface/caller/repo involved.
- Section D lists paths; full bodies appear under ## File contents in the prompt.
- Treat Section C, Section K (Executor Explanation), and ## File contents as architecture evidence when present.
- Only return NEEDS_WORK for missing architecture when no architecture evidence exists anywhere in the pack.
