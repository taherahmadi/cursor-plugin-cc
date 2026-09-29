---
description: Delegate a coding task to the Cursor CLI agent (Composer by default).
argument-hint: '[--background] [--wait] [--type implement|review|plan|investigate|security] [--retry <n>] [--worktree[=name]] [--fresh] [--resume[=chat-id]] [--model <id>] [--cloud] [--no-force] [--timeout <sec>] <task...>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.mjs" -- "$ARGUMENTS"`

Render the tool output to the user verbatim. If the job ran in the foreground, present the status, files touched, and summary sections as a compact Markdown block. If the job was started in the background, show the returned job id and the `/cursor:status` hint. Do not paraphrase Cursor's summary.

Flags go before the task text. `--type plan` or `--type investigate` run read-only (for design discussion or diagnosis); `--retry <n>` resumes the same chat after a failure; `--worktree` isolates the run and the closing lines say how to inspect it with `/cursor:diff`. When a `.cursor-plugin-cc.json` routed the model, the first line says so — keep it.
