# Notes for AI agents

Assentor is a TypeScript CLI (Node 20+, ESM, vitest, zod, Ink) where one coding agent executes a task and other models review it.

**Continuing the multi-model / app build?** Read [docs/tasks/STATUS.md](docs/tasks/STATUS.md) first. It is the authoritative status, plan, rules and handoff, and it says what to do next.

House rules (details in STATUS.md §2):

- Commit only through `~/commit.sh -m "subject" -m "body"`. No attribution trailers. Never push unless asked. Never use a bare `git stash`.
- Gate before every commit: `pnpm typecheck && pnpm test && pnpm build`, checking real exit codes.
- Task cards live in `docs/tasks/` (index and Danger list: `docs/tasks/README.md`). Stay inside a card's allowed files and escalate instead of guessing.
- Danger-list work (process spawning, git mutations, permission flags, secrets, network servers, file deletion, release chain, shared contracts, config rewrites) needs an independent review and the user's sign-off.
