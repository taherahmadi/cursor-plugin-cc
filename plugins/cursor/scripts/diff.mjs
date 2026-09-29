#!/usr/bin/env node
// Show what a Cursor job changed: the diff between the commit the job started
// from (`baseCommit`, recorded by delegate/review) and the current state of
// the tree it worked in (`workspacePath` — the repo root, or the job's
// worktree). Untracked files are rendered as additions.
import { existsSync } from 'node:fs';
import { parseCommandArgv } from './lib/args.mjs';
import { diffSince, isGitRepo, repoRoot } from './lib/git.mjs';
import { jobNotFoundMessage } from './lib/hints.mjs';
import { listJobs, resolveJobRef } from './lib/jobs.mjs';

const STATUS_GLYPH = { running: '◐', done: '✓', failed: '✗', cancelled: '⊘' };

/**
 * Most recent job that has something diffable (a base commit), so a bare
 * `/cursor:diff` after a delegate just works.
 *
 * @param {string} root
 */
function latestDiffableJob(root) {
  return listJobs(root).find((j) => typeof j.baseCommit === 'string') ?? null;
}

/**
 * @param {string[]} rawArgv
 * @returns {Promise<number>}
 */
export async function main(rawArgv) {
  const { positional, flags } = parseCommandArgv(rawArgv, ['stat', 'name-only', 'json']);
  const root = await repoRoot(process.cwd());
  const ref = positional[0];

  let job;
  if (ref) {
    const resolved = resolveJobRef(root, ref);
    if (resolved.ambiguous) {
      process.stderr.write(
        `Job id \`${ref}\` is ambiguous: ${resolved.ambiguous.map((j) => `\`${j.id}\``).join(', ')}. Use a longer prefix.\n`,
      );
      return 2;
    }
    job = resolved.job;
    if (!job) {
      process.stderr.write(jobNotFoundMessage(ref));
      return 1;
    }
  } else {
    job = latestDiffableJob(root);
    if (!job) {
      process.stderr.write(
        'No Cursor job with a recorded base commit for this repository yet. Run `/cursor:delegate` first, or pass a job id.\n',
      );
      return 1;
    }
  }

  const workspace = job.worktreePath ?? job.workspacePath ?? job.repoPath;
  if (!workspace || !existsSync(workspace)) {
    process.stderr.write(
      `Job \`${job.id}\` worked in \`${workspace ?? '?'}\`, which no longer exists — nothing to diff.\n`,
    );
    return 1;
  }
  if (!(await isGitRepo(workspace))) {
    process.stderr.write(`\`${workspace}\` is not a git repository — nothing to diff against.\n`);
    return 1;
  }
  if (!job.baseCommit) {
    process.stderr.write(
      `Job \`${job.id}\` predates base-commit tracking; showing the whole working tree against HEAD instead.\n`,
    );
  }

  const format =
    flags['name-only'] || flags['nameOnly'] ? 'name-only' : flags['stat'] ? 'stat' : 'patch';
  const diff = await diffSince(workspace, { base: job.baseCommit ?? null, format });
  if (diff.error) {
    process.stderr.write(`${diff.error}\n`);
    return 1;
  }

  if (flags['json']) {
    process.stdout.write(
      JSON.stringify(
        {
          id: job.id,
          status: job.status,
          workspace,
          baseCommit: job.baseCommit ?? null,
          worktree: job.worktreeName ?? null,
          files: diff.files,
          isEmpty: diff.isEmpty,
          ...(format === 'patch' ? { patch: diff.text } : { text: diff.text }),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  const glyph = STATUS_GLYPH[job.status] ?? '•';
  const where = job.worktreePath ? `worktree \`${job.worktreePath}\`` : `\`${workspace}\``;
  const base = job.baseCommit ? job.baseCommit.slice(0, 10) : 'HEAD';
  process.stdout.write(`${glyph} ${job.status}  job \`${job.id}\` — ${where} vs \`${base}\`\n\n`);
  if (diff.isEmpty) {
    process.stdout.write('No changes since the job started.\n');
    return 0;
  }
  if (format === 'patch') {
    process.stdout.write('```diff\n' + diff.text.trimEnd() + '\n```\n');
  } else {
    process.stdout.write('```\n' + diff.text.trimEnd() + '\n```\n');
  }
  if (job.worktreePath) {
    process.stdout.write(
      `\nBring it into your branch with \`git -C ${workspace} diff ${base} | git apply\` or cherry-pick from the worktree branch.\n`,
    );
  }
  return 0;
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`diff failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
