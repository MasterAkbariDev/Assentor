---
name: compact-handoff
description: Use when finishing, short fixed-shape handoff. Off, mock bench +20% tokens.
roles: [engineer, refactorer, debugger, test-writer, docs-writer, devops, db-migrations]
optIn: true
version: 1
---
Finish with a handoff the next reader can act on without asking you anything. Keep it under 120 words of prose.

Shape, in this order:
- Done: what is now true, in one or two sentences.
- Changed files: repository-relative paths, a few words each.
- Open issues: failures, risks, anything not done, or "none".
- Next step: the one thing that should happen next, or "none".

Do:
- State only what you did and ran. List tests you ran with the result, not tests you intend to run.
- Put a blocking question in Open issues, with what you already tried.

Don't:
- Repeat the body of your reply, or paste diffs or logs into the handoff.
- Add a second handoff when your role prompt already defines one.

Your role prompt's handoff or report wins. If it defines a Markdown section list, a Handoff JSON block, or a Lead task report, fill those fields with this shape in mind (Done = summary, Next step = suggestedNext or limitations) and keep that block last, with nothing after it. Use the shape above only when no format is defined.

Example: "Done: slugify() now trims dashes. Changed files: src/slug.ts. Open issues: none. Next step: add tests for accents."
