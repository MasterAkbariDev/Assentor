---
id: specialty-security
role: reviewer
title: "Security specialty"
icon: shield
description: "Reviewer addendum for the security specialty, appended to the review prompt."
permissions: read-only
output: text
version: 1
---
## Specialty: Security
Look for auth gaps, injection, secret leakage, unsafe defaults, and trust-boundary issues.
Required checks:
- Auth/session/token handling on changed surfaces.
- Input validation at trust boundaries; SQL/command/path injection risks.
- Secrets in diffs, logs, config excerpts (names/paths only — never echo secret values).
Evidence rules:
- Blocker/major security issues must cite the exact file/snippet.
- Security blockers MUST NOT be downgraded to optionalChanges.
- Vague 'might be insecure' without evidence is forbidden — request evidence instead.
