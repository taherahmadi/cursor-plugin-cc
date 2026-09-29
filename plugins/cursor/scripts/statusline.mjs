#!/usr/bin/env node
// Claude Code statusLine widget: one short line about the Cursor jobs running
// for the repository the session is in, nothing when idle.
//
//   ◐ 2 cursor · 3m 12s
//
// Claude Code re-runs the statusLine command on every refresh and pipes a JSON
// document on stdin (session id, cwd, workspace.current_dir, model, …). The
// widget uses `workspace.current_dir` (falling back to `cwd`) to scope the
// count to the current repo, reads only the small job records, and prints a
// deterministic spinner frame keyed on elapsed time — no timers, no colour.
//
// Wire it with `/cursor:setup --install-statusline`, or chain it into an
// existing statusLine command (see `/cursor:setup --statusline`).

import { readFileSync } from 'node:fs';
import { repoRoot } from './lib/git.mjs';
import { isCrashed, listJobs } from './lib/jobs.mjs';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** @returns {Record<string, unknown>} */
function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function currentDirFrom(input) {
  // For chained status bars that cannot forward Claude Code's stdin JSON.
  const override = process.env.CURSOR_PLUGIN_CC_STATUSLINE_CWD;
  if (override && override.trim()) return override;
  const ws = input.workspace;
  if (ws && typeof ws === 'object') {
    const dir = /** @type {Record<string, unknown>} */ (ws).current_dir;
    if (typeof dir === 'string' && dir.trim()) return dir;
  }
  if (typeof input.cwd === 'string' && input.cwd.trim()) return input.cwd;
  return process.cwd();
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function fmtElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * @param {import('./lib/jobs.mjs').JobRecord[]} jobs
 * @param {number} [now]
 * @returns {string}   Empty when nothing is running.
 */
export function renderStatusline(jobs, now = Date.now()) {
  const running = jobs.filter((j) => j.status === 'running' && !isCrashed(j));
  if (running.length === 0) return '';
  let maxElapsed = 0;
  for (const j of running) {
    const started = new Date(j.startedAt).getTime();
    if (Number.isFinite(started)) maxElapsed = Math.max(maxElapsed, (now - started) / 1000);
  }
  const frame = FRAMES[Math.floor(maxElapsed) % FRAMES.length];
  const groups = new Set(running.map((j) => j.groupId).filter(Boolean));
  const label =
    groups.size > 0
      ? `${running.length} cursor (${groups.size} fanout)`
      : `${running.length} cursor`;
  return `${frame} ${label} · ${fmtElapsed(maxElapsed)}`;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Promise<string>}
 */
export async function statuslineFor(input) {
  const dir = currentDirFrom(input);
  const root = await repoRoot(dir);
  return renderStatusline(listJobs(root));
}

/**
 * @returns {Promise<number>}
 */
export async function main() {
  const line = await statuslineFor(readStdinJson());
  if (line) process.stdout.write(line + '\n');
  return 0;
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch(() => {
      // A broken widget must never break the status bar.
      process.exit(0);
    });
}
