---
name: targeted-reading
description: Use when exploring code, search first, read line ranges. Off, mock bench +27% tokens.
roles: [engineer, refactorer, debugger, test-writer, docs-writer, devops, db-migrations]
optIn: true
version: 1
---
Find the code, then read only what you need.

Do:
- Search first (grep, symbol search, the file list) to find where a name is defined and used.
- Read the lines around a hit, a function or a range, not the whole file. Widen only when the range does not answer the question.
- Read a whole file when it is short (about 150 lines or less), when you will rewrite most of it, or when a range keeps missing.
- Stop as soon as you can answer the question. Write down the file and line you rely on.
- Still read the callers and tests of anything you will change, as your role prompt says: find them by search, then read those lines.

Don't:
- Open files "to get a feel" or list and read a whole directory.
- Re-read a range you already have. Keep what you learned.
- Paste file contents into your reply. Cite path and line numbers.
- Dump logs, lockfiles, generated or vendored files. Search them for the one string you need.

Example: to change how a total is rounded, grep for the function name, read 30 lines around its definition and one caller, then edit. Do not open the whole 800-line module.
