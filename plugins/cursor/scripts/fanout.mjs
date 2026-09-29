#!/usr/bin/env node
// Run several Cursor tasks in parallel, bounded by `--parallel`, and report a
// synthesis when they are all done. Each task is an ordinary job (visible in
// /cursor:status, /cursor:result, /cursor:diff, /cursor:cancel) stamped with a
// group id. `implement` tasks default to their own worktree so parallel writers
// never collide in one working tree.
import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapsePromptArgv, parseArgv } from './lib/args.mjs';
import { defaultRunFlags, parseRetry, runTaskJob } from './delegate.mjs';
import { isGitRepo, repoRoot } from './lib/git.mjs';
import {
  groupJobs,
  listGroups,
  parseTasks,
  readGroup,
  resolveGroupRef,
  updateGroup,
  writeGroup,
} from './lib/groups.mjs';
import { id as newId } from './lib/id.mjs';
import { pruneOlderThanDays, rawLogPath } from './lib/jobs.mjs';
import { mdCell } from './lib/md.mjs';
import { ensureDir, logsDir } from './lib/paths.mjs';
import { isKnownTaskType, normaliseTaskType, readRepoConfig, TASK_TYPES } from './lib/routing.mjs';

const BOOLEAN_FLAGS = ['background', 'wait', 'worktree', 'git-check', 'json', 'help'];
const DEFAULT_PARALLEL = 4;
const MAX_PARALLEL = 16;

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
export function parseParallel(raw, fallback = DEFAULT_PARALLEL) {
  const n = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_PARALLEL);
}

function parseFlags(argv) {
  const { positional, flags } = parseArgv(argv, BOOLEAN_FLAGS);
  const explicitWait = flags['wait'] === true;
  const background = Boolean(flags['background']) && !explicitWait;
  const noGitCheck =
    flags['gitCheck'] === false ||
    flags['git-check'] === false ||
    flags['no-git-check'] === true ||
    flags['noGitCheck'] === true;
  // `--no-worktree` → false; unset → undefined (per-type default applies).
  const worktree = 'worktree' in flags ? Boolean(flags['worktree']) : undefined;
  return {
    body: positional.join(' ').trim(),
    background,
    noGitCheck,
    worktree,
    json: Boolean(flags['json']),
    parallelRaw: flags['parallel'],
    model: typeof flags['model'] === 'string' ? flags['model'] : undefined,
    type: normaliseTaskType(flags['type']) ?? 'implement',
    retry: parseRetry(flags['retry']),
    timeoutRaw: flags['timeout'],
    tasksFile: typeof flags['tasks-file'] === 'string' ? flags['tasks-file'] : undefined,
    collect: typeof flags['collect'] === 'string' ? flags['collect'] : undefined,
    worker: typeof flags['worker'] === 'string' ? flags['worker'] : undefined,
  };
}

/**
 * @param {ReturnType<typeof parseFlags>} flags
 * @param {{type: string, prompt: string}} task
 * @param {string} groupId
 */
function flagsForTask(flags, task, groupId) {
  // Writers isolate by default; read-only types never need a worktree.
  const worktree = flags.worktree ?? task.type === 'implement';
  return defaultRunFlags({
    model: flags.model,
    type: task.type,
    retry: flags.retry,
    timeoutRaw: flags.timeoutRaw,
    worktree,
    group: groupId,
  });
}

function duration(job) {
  if (!job?.startedAt) return null;
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  const ms = end - new Date(job.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function fmtMs(ms) {
  if (ms == null) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('[plugin post-flight]')) ?? ''
  );
}

/**
 * Markdown synthesis for a group: per-task table, counts, wall clock and the
 * speedup over running the same tasks serially.
 *
 * @param {string} root
 * @param {import('./lib/groups.mjs').GroupRecord} group
 * @returns {string}
 */
export function renderSynthesis(root, group) {
  const rows = groupJobs(root, group);
  const lines = [];
  lines.push(`### Fanout \`${group.id}\` — ${group.status}`);
  lines.push('');
  lines.push('| # | Type | Job | Status | Attempts | Duration | Files | Summary |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  let done = 0;
  let sumMs = 0;
  let maxMs = 0;
  for (const { task, job } of rows) {
    const status = job?.status ?? 'missing';
    if (status === 'done') done += 1;
    const ms = duration(job);
    if (ms != null) {
      sumMs += ms;
      maxMs = Math.max(maxMs, ms);
    }
    const files = job?.filesTouched?.length ?? 0;
    const summary = job ? firstLine(job.summary) : '(no job record)';
    lines.push(
      `| ${task.index + 1} | ${mdCell(task.type)} | \`${task.jobId}\` | ${mdCell(status)} | ${
        job?.attempts ?? '-'
      } | ${fmtMs(ms)} | ${files} | ${mdCell(summary).slice(0, 80)} |`,
    );
  }
  const wallMs = group.finishedAt
    ? new Date(group.finishedAt).getTime() - new Date(group.createdAt).getTime()
    : Date.now() - new Date(group.createdAt).getTime();
  const failed = rows.length - done;
  lines.push('');
  lines.push(
    `**${rows.length} task(s):** ${done} done, ${failed} failed · **wall clock** ${fmtMs(wallMs)} · **serial estimate** ${fmtMs(
      sumMs,
    )}${sumMs > 0 && wallMs > 0 ? ` · **speedup** ${(sumMs / wallMs).toFixed(2)}×` : ''}`,
  );
  const worktrees = rows.filter(({ job }) => job?.worktreePath || job?.worktreeName);
  if (worktrees.length > 0) {
    lines.push('');
    lines.push('Isolated runs — inspect each with `/cursor:diff <job-id>`:');
    for (const { job } of worktrees) {
      lines.push(`- \`${job.id}\` → \`${job.worktreePath ?? job.worktreeName}\``);
    }
  }
  lines.push('');
  lines.push(
    `Details: \`/cursor:status --group ${group.id}\` · re-print: \`/cursor:fanout --collect ${group.id}\``,
  );
  return lines.join('\n') + '\n';
}

/**
 * Run every task in the group with at most `parallel` in flight.
 *
 * @param {string} root
 * @param {import('./lib/groups.mjs').GroupRecord} group
 * @param {ReturnType<typeof parseFlags>} flags
 * @param {(line: string) => void=} log
 */
async function runGroup(root, group, flags, log) {
  const queue = [...group.tasks];
  const inFlight = new Set();
  const runOne = async (task) => {
    const p = runTaskJob({
      root,
      jobId: task.jobId,
      prompt: task.prompt,
      flags: flagsForTask(flags, { type: task.type, prompt: task.prompt }, group.id),
      background: Boolean(group.background),
    })
      .then((outcome) => {
        log?.(
          `${outcome.status === 'done' ? '✓' : '✗'} task ${task.index + 1} (${task.type}) \`${task.jobId}\` — ${outcome.status}${
            outcome.attempts > 1 ? `, ${outcome.attempts} attempts` : ''
          }\n`,
        );
      })
      .catch((err) => {
        log?.(
          `✗ task ${task.index + 1} \`${task.jobId}\` crashed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < group.parallel) {
      const task = queue.shift();
      if (task) await runOne(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  return updateGroup(root, group.id, { status: 'done', finishedAt: new Date().toISOString() });
}

function spawnBackground(groupId, root) {
  const selfPath = fileURLToPath(import.meta.url);
  ensureDir(logsDir(root));
  const logBase = rawLogPath(root, `group-${groupId}`);
  const out = openSync(`${logBase}.stdout`, 'a');
  const err = openSync(`${logBase}.stderr`, 'a');
  const child = spawn(process.execPath, [selfPath, '--worker', groupId], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CURSOR_PLUGIN_CC_WORKER: '1', CURSOR_PLUGIN_CC_REPO_ROOT: root },
  });
  child.unref();
  return child.pid ?? -1;
}

/**
 * @param {string[]} rawArgv
 * @returns {Promise<number>}
 */
export async function main(rawArgv) {
  const flags = parseFlags(collapsePromptArgv(rawArgv, BOOLEAN_FLAGS));

  if (flags.worker) {
    const root = process.env.CURSOR_PLUGIN_CC_REPO_ROOT ?? (await repoRoot(process.cwd()));
    const group = readGroup(root, flags.worker);
    if (!group) {
      process.stderr.write(`fanout worker: group ${flags.worker} not found\n`);
      return 1;
    }
    updateGroup(root, group.id, { pid: process.pid });
    await runGroup(root, group, flags);
    return 0;
  }

  const root = await repoRoot(process.cwd());

  if (flags.collect) {
    const { group, ambiguous } = resolveGroupRef(root, flags.collect);
    if (ambiguous) {
      process.stderr.write(
        `Group \`${flags.collect}\` is ambiguous: ${ambiguous.map((g) => g.id).join(', ')}.\n`,
      );
      return 2;
    }
    if (!group) {
      const known = listGroups(root)
        .slice(0, 5)
        .map((g) => `\`${g.id}\``);
      process.stderr.write(
        `No fanout group \`${flags.collect}\` for this repository.${known.length ? ` Known: ${known.join(', ')}.` : ''}\n`,
      );
      return 1;
    }
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ group, jobs: groupJobs(root, group).map((r) => r.job) }, null, 2) + '\n',
      );
      return 0;
    }
    process.stdout.write(renderSynthesis(root, group));
    return 0;
  }

  if (!isKnownTaskType(flags.type)) {
    process.stderr.write(
      `Error: unknown --type "${flags.type}". Use one of: ${TASK_TYPES.join(', ')}.\n`,
    );
    return 2;
  }

  let body = flags.body;
  let fromFile = false;
  if (flags.tasksFile) {
    try {
      body = readFileSync(resolve(process.cwd(), flags.tasksFile), 'utf8');
      fromFile = true;
    } catch (err) {
      process.stderr.write(
        `Error: cannot read --tasks-file ${flags.tasksFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }
  const tasks = parseTasks(body, { fromFile, defaultType: flags.type });
  if (tasks.length === 0) {
    process.stderr.write('Error: no tasks given.\n');
    process.stderr.write(
      'Usage: /cursor:fanout [flags] <task 1> ;; <task 2> ;; review: <task 3>   (or --tasks-file <path>)\n',
    );
    return 2;
  }

  const inGit = await isGitRepo(process.cwd());
  if (!inGit && !flags.noGitCheck) {
    process.stderr.write(
      'Error: current directory is not a git repository. Pass --no-git-check to override.\n',
    );
    return 2;
  }
  if (!inGit) flags.worktree = false; // nothing to isolate from

  pruneOlderThanDays(root, 30);
  const { config } = readRepoConfig(root);
  const parallel = parseParallel(
    flags.parallelRaw,
    parseParallel(config.maxFanout, DEFAULT_PARALLEL),
  );
  const groupId = newId(8);
  const group = writeGroup(root, {
    id: groupId,
    repoPath: root,
    createdAt: new Date().toISOString(),
    parallel,
    status: 'running',
    background: flags.background,
    tasks: tasks.map((t, index) => ({ index, jobId: newId(10), type: t.type, prompt: t.prompt })),
  });

  const header =
    `Fanout \`${groupId}\`: ${tasks.length} task(s), up to ${parallel} in parallel` +
    `${flags.model ? `, model \`${flags.model}\`` : ''}${flags.retry ? `, retry ${flags.retry}` : ''}.\n`;

  if (flags.background) {
    const pid = spawnBackground(groupId, root);
    updateGroup(root, groupId, { pid });
    process.stdout.write(header);
    for (const t of group.tasks)
      process.stdout.write(
        `- ${t.index + 1}. ${t.type}: \`${t.jobId}\` — ${mdCell(t.prompt).slice(0, 70)}\n`,
      );
    process.stdout.write(
      `\nRunning in background (pid ${pid}). Watch with \`/cursor:status --group ${groupId}\`; collect with \`/cursor:fanout --collect ${groupId}\`.\n`,
    );
    return 0;
  }

  process.stdout.write(header + '\n');
  const finished = await runGroup(root, group, flags, (line) => process.stdout.write(line));
  process.stdout.write('\n');
  process.stdout.write(renderSynthesis(root, finished ?? group));
  const allDone = groupJobs(root, finished ?? group).every(({ job }) => job?.status === 'done');
  return allDone ? 0 : 1;
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `fanout failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
