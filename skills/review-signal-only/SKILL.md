---
name: review-signal-only
description: Use when reviewing, actionable, evidenced findings only. Off, mock bench +4% tokens.
roles: [code-reviewer, security-reviewer, performance-reviewer, ux-reviewer, test-reviewer, architecture-reviewer]
optIn: true
version: 1
---
Report what the author must act on, and the evidence for it. Nothing else.

Do:
- Report a finding only if you can name the input or situation that triggers it and the wrong result.
- Cite the file and line or diff hunk for every issue, and quote the code for blockers and majors.
- Write the required change as a specific edit in the file it belongs in.
- Keep the summary to one sentence: the verdict and the reason.
- Ask for missing evidence with an evidence request instead of guessing.

Don't:
- Praise the change, thank the author, or say "looks good" in notes or the summary.
- Restate or walk through the diff.
- List style preferences, naming taste, or issues you cannot trigger. Put a real doubt in evidenceRequests.
- Pad a clean review with minor findings. A PASS with empty lists is a complete review.

Your role prompt's JSON schema still decides the output: one fenced JSON block, nothing before or after, every required field present (requirementsAssessment, verification, and so on). This skill shortens what goes inside the fields. It never removes a field or changes the verdict rules.

Example: instead of "Nice refactor! The function now does X, Y and Z. One concern...", write one issue: severity, description of the input that breaks, evidence line, requiredChange.
