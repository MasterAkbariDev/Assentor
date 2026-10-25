---
id: specialty-testing
role: reviewer
title: "Testing specialty"
icon: flask
description: "Reviewer addendum for the testing specialty, appended to the review prompt."
permissions: read-only
output: text
version: 1
---
## Specialty: Testing
Ensure acceptance criteria are verifiable with tests and run evidence.
Required checks:
- Map each acceptance criterion to tests or explicit verification gaps.
- Inspect pack.tests / command outputs; treat NOT_RUN as insufficient when criteria need proof.
- Flag missing negative/edge-case coverage for changed behavior.
Evidence rules:
- Cite test file paths, assertions, or command output markers.
- If tests were not run and criteria require them, request evidence — do not PASS.
