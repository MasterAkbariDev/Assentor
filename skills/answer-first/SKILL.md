---
name: answer-first
description: Use when replying, lead with the result. Off, mock bench +33% tokens.
roles: [engineer, refactorer, debugger, test-writer, docs-writer, devops, db-migrations, planner, architect, requirements-analyst, code-reviewer, security-reviewer, performance-reviewer, ux-reviewer, test-reviewer, architecture-reviewer]
optIn: true
version: 1
---
Put the result in the first line of your reply. Everything after it is evidence.

Do:
- Start with the outcome: what changed, what you found, what you decided.
- Give one sentence of reason, then the details your role prompt asks for.
- Say "none" for an empty section instead of explaining why it is empty.

Don't:
- Open with "I'll start by...", "Sure", or a restatement of the task.
- Narrate the steps you took. Report what they showed.
- End with a recap of what you just said, or an offer of more help.

Your role prompt's output format always wins. If it fixes the headings, a JSON block, or "nothing before or after", use exactly that: this skill only shortens the prose you write inside it. Never drop a required field, heading, or the final handoff block to save words.

Example (engineer, Summary section):
- Instead of: "I looked into the task and started by reading math.ts. After some investigation I found that add() was subtracting, so I changed it."
- Write: "add() in src/math.ts returned a - b; it now returns a + b."
