---
description: Show active and recent Cursor jobs for this repository.
argument-hint: '[job-id] [--group <fanout-id>] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" -- "$ARGUMENTS"`

If no id was passed, render the output as a single compact Markdown table. If a specific id (or `--group <fanout-id>`) was passed, present the output verbatim without summarisation. A job id may be a unique prefix. A `crashed` status means the record still says running but its worker process is gone.
