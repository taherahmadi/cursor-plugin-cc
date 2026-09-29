#!/usr/bin/env node
// Test stub for `cursor-agent`. Emits a fixture NDJSON stream chosen by
// the CURSOR_AGENT_STUB_FIXTURE env var, then exits.
//
// Extra knobs for the retry / fanout / worktree tests:
//   CURSOR_AGENT_STUB_SEQUENCE   comma-separated fixture paths played in order
//                                across invocations (last one repeats); needs
//                                CURSOR_AGENT_STUB_COUNTER, a file the stub
//                                bumps on every call.
//   CURSOR_AGENT_STUB_ARGS_OUT   append one JSON line per invocation with the
//                                argv the stub received (and the prompt).
//   CURSOR_AGENT_STUB_DELAY_MS   sleep before replaying (parallelism tests).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// `cursor-agent status` — auth check used by authStatus(). Controlled by
// CURSOR_AGENT_STUB_AUTH: 'out' simulates a logged-out CLI.
if (process.argv[2] === 'status') {
  if (process.env.CURSOR_AGENT_STUB_AUTH === 'out') {
    process.stdout.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write('Logged in as test-stub\n');
  process.exit(0);
}

// Like the real cursor-agent in print mode, the prompt arrives on stdin.
// CURSOR_AGENT_STUB_PROMPT_OUT lets tests assert what was received.
let prompt = '';
try {
  prompt = readFileSync(0, 'utf8');
} catch {
  /* stdin ignored or closed */
}
if (process.env.CURSOR_AGENT_STUB_PROMPT_OUT) {
  writeFileSync(process.env.CURSOR_AGENT_STUB_PROMPT_OUT, prompt);
}

let call = 0;
if (process.env.CURSOR_AGENT_STUB_COUNTER) {
  try {
    call = Number(readFileSync(process.env.CURSOR_AGENT_STUB_COUNTER, 'utf8').trim()) || 0;
  } catch {
    call = 0;
  }
  writeFileSync(process.env.CURSOR_AGENT_STUB_COUNTER, String(call + 1));
}

if (process.env.CURSOR_AGENT_STUB_ARGS_OUT) {
  appendFileSync(
    process.env.CURSOR_AGENT_STUB_ARGS_OUT,
    JSON.stringify({ call, argv: process.argv.slice(2), prompt, cwd: process.cwd() }) + '\n',
  );
}

let fixture = process.env.CURSOR_AGENT_STUB_FIXTURE;
if (process.env.CURSOR_AGENT_STUB_SEQUENCE) {
  const seq = process.env.CURSOR_AGENT_STUB_SEQUENCE.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  fixture = seq[Math.min(call, seq.length - 1)] ?? fixture;
}
if (!fixture) {
  process.stderr.write('stub: CURSOR_AGENT_STUB_FIXTURE not set\n');
  process.exit(2);
}

let content;
try {
  content = readFileSync(fixture, 'utf8');
} catch (err) {
  process.stderr.write(`stub: failed to read fixture ${fixture}: ${err.message}\n`);
  process.exit(2);
}

const delay = Number(process.env.CURSOR_AGENT_STUB_DELAY_MS) || 0;

function replay() {
  const lines = content.split('\n').filter((l) => l.length > 0);
  let failure = false;
  for (const line of lines) {
    process.stdout.write(line + '\n');
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'result' && parsed.is_error === true) {
        failure = true;
      }
    } catch {
      /* noop */
    }
  }

  if (process.env.CURSOR_AGENT_STUB_HANG === '1') {
    // Simulate cursor-agent not self-exiting after `result`.
    setInterval(() => {}, 1_000);
  } else {
    process.exit(failure ? 1 : 0);
  }
}

if (delay > 0) setTimeout(replay, delay);
else replay();
