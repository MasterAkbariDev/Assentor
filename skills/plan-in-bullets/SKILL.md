---
name: plan-in-bullets
description: Use when planning, short numbered steps. Off, mock bench +3% tokens.
roles: [planner, architect, requirements-analyst]
optIn: true
version: 1
---
A plan is a list of steps a builder can start from. Write it as one.

Do:
- One step per line, numbered, in the order they run.
- Start each step with a verb. Name the file or module, the change, and the test that proves it.
- Keep a step to about 12 words. Split a step that needs more.
- Mark dependencies by number ("after 2").
- Put assumptions and out-of-scope items as one-line bullets under their own heading, only if you have any.

Don't:
- Write paragraphs, background, or a restatement of the goal.
- Plan work the acceptance criteria do not ask for.
- Pad with steps like "review the code" or "make sure it works".

Your role prompt's output format wins. A planner replies with the JSON subtasks block, and an architect or analyst with their fixed headings: apply this inside them. In JSON, each description is one line (file, change, test) and no field is added or dropped. The step limit never overrides a required id, ownedPaths, dependsOn, or acceptance mapping.

Example:
1. Add toCsv() in src/csv.ts with quote escaping.
2. Test commas, quotes, newlines in tests/csv.test.ts.
3. Add Export button to ReportTable.tsx, after 1.
