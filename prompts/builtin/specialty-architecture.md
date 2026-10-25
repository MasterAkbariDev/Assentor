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
- If structure or architecture sections are missing, return NEEDS_WORK with evidenceRequests.
