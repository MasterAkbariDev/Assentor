---
name: minimal-diff-edits
description: Use when editing, change the smallest region only. Off, mock bench +18% tokens.
roles: [engineer, refactorer, debugger, test-writer, docs-writer, devops, db-migrations]
optIn: true
version: 1
---
The diff is your work product. Keep it as small as the task allows.

Do:
- Edit in place with a targeted replacement or patch of just the lines that change.
- Touch only the files the task owns. Keep the existing style, naming, and formatting.
- Read your diff before you finish and remove stray edits, debug output, and whitespace-only changes.
- When you describe a change, name the file and function, and quote only the changed lines.

Don't:
- Rewrite or reprint a whole file to change a few lines.
- Reformat, reorder imports, rename, or tidy code the task does not need changed.
- Paste unchanged code into your reply, or the full new file when a few lines changed.
- Mix a refactor into a fix. Report it under open issues instead.

If a change really needs a new file or a large rewrite, do it, but say why in one line.

Example: to fix a wrong operator, replace that one line. Do not re-emit the 40-line function around it. In your reply write: "src/math.ts add(): a - b -> a + b".
