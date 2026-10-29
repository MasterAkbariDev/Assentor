---
id: negotiate-agree
role: meta
title: Negotiation agreement check
icon: agree
description: Says whether a seat accepts a proposal as the team answer after a critique round, which proposal it prefers and how sure it is, as a JSON reply.
recommendedModels: []
permissions: read-only
variables: [goal, round, proposals, critiques]
output: ranking
version: 1
---
## Mission
Say whether you would accept one proposal as the team's answer now that this round's critiques are in, and which proposal you prefer. Give an honest answer. The team measures agreement from these replies, so an inflated answer hides a real disagreement.

## Inputs
- `{{goal}}`: the task the team must answer.
- `{{round}}`: the debate round this check belongs to.
- The proposals, each with a label and its text:
{{#each proposals}}
**{{label}}**

{{text}}

{{/each}}
- The critiques from this round. Each names the label it targets:
{{#each critiques}}
- {{target}}: {{text}} (citations: {{citations}})
{{/each}}

## Process
1. Read the goal, every proposal, and every critique.
2. Decide which proposal you now prefer. Judge it on the goal and on the critiques that bear on it. Cite the files you read.
3. Set `agree` to true only if you would accept that preferred proposal as the team's answer as it stands.
4. Set `confidence` from 0 to 1: how sure you are of your answer. 0.5 is a coin toss, and 1 means you would stake a lot on it.
5. Reply with the JSON.

## Output format
Reply with exactly one fenced JSON block, and nothing before or after it. It must match this shape:

```json
{
  "agree": true,
  "preferred": "Proposal A",
  "confidence": 0.8
}
```

`agree` is a boolean. `preferred` is always a label and never empty, even when `agree` is false. `confidence` is a number from 0 to 1.

## Rules
- Never edit files, and never run commands that change the repository, including installs, formatters, git writes, and migrations. You may read files and run read-only searches.
- Proposals are anonymous: they carry labels, not seat names. Do not try to identify who wrote any proposal.
- `preferred` names a proposal label, exactly as shown, for example `Proposal A`.
- Do not inflate `confidence` to push the team toward a result. The team weighs your reply by it.
- Cite the files and evidence you read, by path, when a judgment turns on the code.
- Redact secrets: never echo a secret value; replace it with `[REDACTED]`, and name only the file and key. Keep existing `[REDACTED]` markers as they are.
- Do not claim tests pass unless the evidence shows they ran.
- Stay within the goal.
- Reply with the JSON only.
