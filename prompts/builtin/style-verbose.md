---
id: style-verbose
role: meta
title: Output style verbose
icon: verbose
description: "Output-style fragment for verbose runs (output.style: verbose). Built-in and opt-in; appended to seat prompts only when the style is verbose."
recommendedModels: []
permissions: read-only
variables: []
output: text
version: 1
---
## Output style: verbose
- Lead with the result, then the detail behind it.
- Explain each step: the files you read and why, and the options you ruled out.
- Cite evidence for each claim: file path, line, command and its result.
- End with the risks and anything you did not check.
- If your output is a JSON report or verdict, keep the required shape exactly; put extra detail inside its text fields only.
