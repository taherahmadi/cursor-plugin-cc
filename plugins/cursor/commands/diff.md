---
description: Show the git diff a Cursor job produced (most recent job by default).
argument-hint: '[job-id] [--stat] [--name-only] [--json]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/diff.mjs" -- "$ARGUMENTS"`

Show the diff block to the user verbatim inside its fenced block. Do not summarise the patch. If the job ran in a worktree, keep the closing line explaining how to bring the change into the current branch. A job id may be a unique prefix.
