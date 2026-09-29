// `--worktree` isolation is delegated to cursor-agent's own `--worktree <name>`
// flag: the CLI creates `~/.cursor/worktrees/<repo-name>/<name>` (a real git
// worktree on its own branch) and runs the task there. What the plugin adds
// on top is bookkeeping — a stable name per job and the resolved path on the
// job record — so `/cursor:diff`, `/cursor:status` and `/cursor:result` can
// point at the right tree afterwards. Neither reference implementation kept
// the path, which is why their diff commands showed nothing for worktree jobs.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * @param {string} jobId
 * @returns {string}
 */
export function worktreeNameFor(jobId) {
  // Branch- and path-safe: job ids are base64url (`A-Za-z0-9-_`).
  return `cursor-${jobId}`;
}

/**
 * Where cursor-agent keeps its worktrees. Overridable for tests.
 * @returns {string}
 */
export function cursorWorktreesRoot() {
  const fromEnv = process.env.CURSOR_PLUGIN_CC_CURSOR_WORKTREES;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
  return join(homedir(), '.cursor', 'worktrees');
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * Best-effort resolution of the worktree cursor-agent actually used.
 *
 * Order: the `cwd` reported by the stream's `system/init` event (authoritative
 * when it differs from the repo root and exists on disk) → the documented
 * `<root>/<repo-name>/<name>` location → any `<root>/*\/<name>` match.
 *
 * @param {{repoRoot: string, name: string, events?: Record<string, unknown>[]}} input
 * @returns {string|null}
 */
export function resolveWorktreePath(input) {
  for (const ev of input.events ?? []) {
    if (ev && ev.type === 'system' && typeof ev.cwd === 'string' && ev.cwd.trim()) {
      const cwd = ev.cwd.trim();
      if (existsSync(cwd) && !samePath(cwd, input.repoRoot)) return cwd;
    }
  }
  const root = cursorWorktreesRoot();
  const documented = join(root, basename(input.repoRoot), input.name);
  if (existsSync(documented)) return documented;
  try {
    for (const repoDir of readdirSync(root, { withFileTypes: true })) {
      if (!repoDir.isDirectory()) continue;
      const candidate = join(root, repoDir.name, input.name);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no worktrees root yet
  }
  return null;
}
