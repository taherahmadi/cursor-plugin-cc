---
description: Run several Cursor tasks in parallel (bounded) and get one synthesis when they finish.
argument-hint: '[--parallel <n>] [--background] [--type <t>] [--model <id>] [--retry <n>] [--no-worktree] [--tasks-file <path>] <task 1> ;; <task 2> ;; review: <task 3>   |   --collect <group-id>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/fanout.mjs" -- "$ARGUMENTS"`

Render the output verbatim. In the foreground the command prints one line per task as it finishes, then a synthesis table (status, attempts, duration, files, one-line summary per task) with wall-clock and speedup figures — present that table as-is. In the background it prints the group id and the job ids; tell the user to watch with `/cursor:status --group <id>` and collect with `/cursor:fanout --collect <id>`. Tasks are separated by `;;`; a task may start with `implement:`, `review:`, `plan:`, `investigate:` or `security:` to route it to that type's model. `implement` tasks run in their own worktrees unless `--no-worktree` is passed.
