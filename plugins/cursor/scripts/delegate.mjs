#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collapsePromptArgv, parseArgv, parseTimeout } from './lib/args.mjs';
import { runHeadless } from './lib/cursor.mjs';
import { headCommit, isGitRepo, repoRoot } from './lib/git.mjs';
import { id as newId } from './lib/id.mjs';
import {
  createJob,
  pruneOlderThanDays,
  rawLogPath as rawLogPathFor,
  readJob,
  updateJob,
} from './lib/jobs.mjs';
import { ensureDir, jobsDir, logsDir } from './lib/paths.mjs';
import { extractChatId, summariseEvents } from './lib/parse.mjs';
import { isKnownTaskType, normaliseTaskType, resolveRoute, TASK_TYPES } from './lib/routing.mjs';
import { resolveWorktreePath, worktreeNameFor } from './lib/worktree.mjs';

const BOOLEAN_FLAGS = [
  'background',
  'wait',
  'fresh',
  'force',
  'cloud',
  'git-check',
  'help',
  'resume',
  // `--worktree` is boolean so it never swallows the first word of the task;
  // a custom name is `--worktree=<name>`.
  'worktree',
];

const DEFAULT_TASK_TYPE = 'implement';
const MAX_RETRIES = 10;

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function parseRetry(raw) {
  const n = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_RETRIES);
}

function parseFlags(argv) {
  const { positional, flags } = parseArgv(argv, BOOLEAN_FLAGS);
  const fresh = Boolean(flags['fresh']);
  const cloud = Boolean(flags['cloud']);
  const noGitCheck =
    flags['gitCheck'] === false ||
    flags['git-check'] === false ||
    flags['no-git-check'] === true ||
    flags['noGitCheck'] === true;
  const explicitForceFlag = 'force' in flags ? Boolean(flags['force']) : undefined;
  const force = explicitForceFlag === undefined ? true : explicitForceFlag;
  // `--wait` forces the foreground even if `--background` is also present,
  // so it is a real toggle rather than a no-op.
  const explicitWait = flags['wait'] === true;
  const background = Boolean(flags['background']) && !explicitWait;
  const wait = !background;
  const timeoutRaw = flags['timeout'];
  const resume = flags['resume'];
  const model = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  const worker = typeof flags['worker'] === 'string' ? flags['worker'] : undefined;
  const type = normaliseTaskType(flags['type']) ?? DEFAULT_TASK_TYPE;
  const retry = parseRetry(flags['retry']);
  const worktreeRaw = flags['worktree'];
  const worktree =
    worktreeRaw === true || (typeof worktreeRaw === 'string' && worktreeRaw.length > 0);
  const worktreeName =
    typeof worktreeRaw === 'string' && worktreeRaw.length > 0 ? worktreeRaw : undefined;
  const worktreeBase =
    typeof flags['worktree-base'] === 'string' ? flags['worktree-base'] : undefined;
  const group = typeof flags['group'] === 'string' ? flags['group'] : undefined;
  return {
    positional,
    model,
    background,
    wait,
    fresh,
    resume,
    force,
    cloud,
    timeoutRaw,
    noGitCheck,
    worker,
    type,
    retry,
    worktree,
    worktreeName,
    worktreeBase,
    group,
  };
}

function isResumeRequested(resume, fresh) {
  if (fresh) return false;
  if (resume === undefined) return false;
  if (typeof resume === 'boolean') return resume;
  // Any non-boolean value (string id, or a numeric id auto-cast by the parser)
  // means "resume" — with an explicit chat id when one was supplied.
  return true;
}

function resumeChatId(resume) {
  if (resume == null || typeof resume === 'boolean') return undefined;
  const s = String(resume).trim();
  if (s.length > 0 && s.toLowerCase() !== 'true') return s;
  return undefined;
}

/**
 * Resolve everything a run needs that depends on the repo: model route, mode,
 * timeout (flag > repo config > 1800 s) and the worktree name.
 *
 * @param {ReturnType<typeof parseFlags>} flags
 * @param {string} root
 * @param {string} jobId
 */
function planRun(flags, root, jobId) {
  const route = resolveRoute({ explicitModel: flags.model, type: flags.type, repoRoot: root });
  const timeout = parseTimeout(flags.timeoutRaw, route.timeout ?? 1800);
  const worktreeName = flags.worktree ? (flags.worktreeName ?? worktreeNameFor(jobId)) : undefined;
  return { route, timeout, worktreeName };
}

/**
 * @param {string} reason
 * @param {string} prompt
 * @returns {string}
 */
export function retryPrompt(reason, prompt) {
  return [
    `The previous attempt at this task ended without completing it (${reason}).`,
    'Continue from where you left off, finish the task, and report what you did.',
    '',
    '---',
    '',
    prompt,
  ].join('\n');
}

/**
 * Run the task, retrying on failure by resuming the same Cursor chat. Shared
 * by the foreground path and the detached background worker.
 *
 * @param {Object} input
 * @param {string} input.jobId
 * @param {string} input.root
 * @param {string} input.prompt
 * @param {ReturnType<typeof parseFlags>} input.flags
 * @param {ReturnType<typeof planRun>} input.plan
 * @param {(ev: Record<string, unknown>) => void=} input.onEvent
 * @param {(line: string) => void=} input.log
 */
async function executeWithRetries({ jobId, root, prompt, flags, plan, onEvent, log }) {
  const { route, timeout, worktreeName } = plan;
  const logPath = rawLogPathFor(root, jobId);
  const wantResume = isResumeRequested(flags.resume, flags.fresh);
  let resumeId = wantResume ? resumeChatId(flags.resume) : undefined;
  let resumeLatest = wantResume && !resumeId;
  let attemptPrompt = prompt;
  let chatId;
  let lastResult;
  let lastSummary;
  let attempts = 0;
  let killedByTimeout = false;
  const maxAttempts = flags.retry + 1;

  while (attempts < maxAttempts) {
    attempts += 1;
    if (attempts > 1) {
      try {
        appendFileSync(logPath, `# attempt ${attempts}\n`, 'utf8');
      } catch {
        // log is best-effort
      }
      log?.(`↻ retry ${attempts - 1}/${flags.retry}${chatId ? ` (resuming ${chatId})` : ''}\n`);
    }
    updateJob(root, jobId, { attempts, status: 'running' });
    const result = await runHeadless({
      prompt: attemptPrompt,
      model: route.model,
      mode: route.mode,
      resumeChatId: resumeId,
      resumeLatest,
      cloud: flags.cloud,
      force: flags.force,
      timeoutSec: timeout,
      // Only the first attempt creates the worktree; a resumed chat already
      // lives in it.
      worktree: attempts === 1 ? worktreeName : undefined,
      worktreeBase: attempts === 1 ? flags.worktreeBase : undefined,
      logPath,
      onSpawn: (pid) => {
        try {
          updateJob(root, jobId, { childPid: pid });
        } catch {
          // noop
        }
      },
      onEvent: (ev) => {
        const id = ev.chat_id ?? ev.chatId ?? ev.session_id ?? ev.sessionId;
        if (typeof id === 'string' && id.length > 0 && id !== chatId) {
          chatId = id;
          try {
            updateJob(root, jobId, { cursorChatId: id });
          } catch {
            // noop
          }
        }
        onEvent?.(ev);
      },
    });
    lastResult = result;
    lastSummary = summariseEvents(result.events);
    chatId = extractChatId(result.events) ?? chatId;

    if (worktreeName && attempts === 1) {
      const path = resolveWorktreePath({
        repoRoot: root,
        name: worktreeName,
        events: result.events,
      });
      updateJob(root, jobId, {
        worktreeName,
        ...(path ? { worktreePath: path, workspacePath: path } : {}),
      });
    }

    const succeeded = result.exitCode === 0 && lastSummary.success && !result.killed;
    if (succeeded) break;
    // A user cancel is terminal; the record already says so.
    if (readJob(root, jobId)?.status === 'cancelled') break;
    if (result.killed) {
      // A run that hit the timeout would just hit it again — never loop on it.
      killedByTimeout = true;
      break;
    }
    if (attempts >= maxAttempts) break;
    const reason = !lastSummary.success ? lastSummary.exitReason : `exit code ${result.exitCode}`;
    attemptPrompt = retryPrompt(reason, prompt);
    resumeId = chatId;
    resumeLatest = false;
  }

  const result = /** @type {import('./lib/cursor.mjs').DelegateResult} */ (lastResult);
  const summary = /** @type {import('./lib/parse.mjs').Summary} */ (lastSummary);
  const status = result.exitCode === 0 && summary.success && !result.killed ? 'done' : 'failed';
  const notes = [];
  if (result.killed) {
    notes.push(
      `The run was killed (timeout or watchdog) before finishing — output may be incomplete.${
        killedByTimeout && flags.retry > 0 ? ' Timeouts are never retried.' : ''
      } Re-run with a larger \`--timeout\` if needed.`,
    );
  }
  if (attempts > 1) {
    notes.push(`Took ${attempts} attempts (${flags.retry} retries allowed).`);
  }
  const noteBlock = notes.length > 0 ? `\n\n[plugin post-flight]\n${notes.join('\n')}` : '';

  const final = updateJob(root, jobId, {
    status,
    exitCode: result.exitCode,
    finishedAt: new Date().toISOString(),
    summary: summary.summary + noteBlock,
    filesTouched: summary.filesTouched,
    attempts,
    childPid: undefined,
    ...(chatId ? { cursorChatId: chatId } : {}),
  });
  return { result, summary, chatId, status, attempts, job: final };
}

/**
 * @param {ReturnType<typeof parseFlags>} flags
 * @param {string} prompt
 * @param {string} jobId
 * @param {string} root
 */
async function createRecord(flags, prompt, jobId, root, plan, background) {
  ensureDir(jobsDir(root));
  ensureDir(logsDir(root));
  createJob({
    id: jobId,
    repoPath: root,
    prompt,
    model: plan.route.model,
    cloud: flags.cloud,
    background,
  });
  const baseCommit = await headCommit(root);
  updateJob(root, jobId, {
    taskType: flags.type,
    routeSource: plan.route.source,
    ...(plan.route.mode ? { mode: plan.route.mode } : {}),
    ...(flags.retry > 0 ? { retryMax: flags.retry } : {}),
    ...(plan.worktreeName ? { worktreeName: plan.worktreeName } : {}),
    ...(flags.group ? { groupId: flags.group } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    workspacePath: root,
  });
}

function describeRun(flags, plan) {
  const bits = [`model \`${plan.route.model}\``];
  if (flags.type !== DEFAULT_TASK_TYPE) bits.push(`type \`${flags.type}\``);
  if (plan.route.mode) bits.push(`mode \`${plan.route.mode}\``);
  if (plan.route.source === 'type' || plan.route.source === 'repo-default') {
    bits.push('routed by `.cursor-plugin-cc.json`');
  }
  if (plan.worktreeName) bits.push(`worktree \`${plan.worktreeName}\``);
  if (flags.retry > 0) bits.push(`retry ${flags.retry}`);
  return bits.join(', ');
}

async function foreground(flags, prompt, jobId, root) {
  const plan = planRun(flags, root, jobId);
  await createRecord(flags, prompt, jobId, root, plan, false);
  updateJob(root, jobId, { pid: process.pid });
  if (plan.route.warning) process.stderr.write(`Warning: ${plan.route.warning}\n`);

  process.stdout.write(`Job \`${jobId}\` started (${describeRun(flags, plan)}, foreground).\n\n`);

  let toolCalls = 0;
  const { result, summary, chatId, status, attempts, job } = await executeWithRetries({
    jobId,
    root,
    prompt,
    flags,
    plan,
    log: (line) => process.stdout.write(line),
    onEvent: (ev) => {
      const type = ev.type;
      if (type === 'tool_use' || type === 'tool_call' || type === 'tool') {
        toolCalls += 1;
        if (toolCalls <= 20) {
          const name =
            (typeof ev.name === 'string' && ev.name) ||
            (typeof ev.tool_name === 'string' && ev.tool_name) ||
            'tool';
          process.stdout.write(`• ${String(name)}\n`);
        } else if (toolCalls === 21) {
          process.stdout.write('• … (further tool calls omitted)\n');
        }
      }
    },
  });

  process.stdout.write('\n---\n');
  process.stdout.write(`**Status:** ${status}${attempts > 1 ? ` (${attempts} attempts)` : ''}\n`);
  if (result.killed)
    process.stdout.write('**⚠ Run was killed before finishing** (timeout/watchdog).\n');
  if (job?.worktreePath) {
    process.stdout.write(
      `**Worktree:** \`${job.worktreePath}\` — inspect with \`/cursor:diff ${jobId}\`.\n`,
    );
  } else if (plan.worktreeName) {
    process.stdout.write(
      `**Worktree:** \`${plan.worktreeName}\` (path not resolved — look under \`~/.cursor/worktrees/\`).\n`,
    );
  }
  if (summary.filesTouched.length > 0) {
    process.stdout.write('**Files touched:**\n');
    for (const f of summary.filesTouched) process.stdout.write(`- ${f}\n`);
  }
  if (summary.summary) {
    process.stdout.write('\n**Summary:**\n\n');
    process.stdout.write(summary.summary.trim() + '\n');
  }
  if (chatId) {
    process.stdout.write(
      `\n**Cursor chat id:** \`${chatId}\` — resume with \`cursor-agent --resume=${chatId}\`.\n`,
    );
  }
  process.stdout.write(`\nRun \`/cursor:status ${jobId}\` for the full record.\n`);
  return result.exitCode;
}

function spawnBackground(jobId, argv, root, extraEnv = {}) {
  const selfPath = fileURLToPath(import.meta.url);
  // Base the capture logs on the resolved repo root (not process.cwd()) so they
  // land in the same jobs/<repo-hash>/ dir as the job record and NDJSON.
  const logPath = rawLogPathFor(root, jobId);
  ensureDir(logsDir(root));
  const out = openSync(`${logPath}.stdout`, 'a');
  const err = openSync(`${logPath}.stderr`, 'a');
  const child = spawn(process.execPath, [selfPath, '--worker', jobId, ...argv], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      CURSOR_PLUGIN_CC_WORKER: '1',
      CURSOR_PLUGIN_CC_REPO_ROOT: root,
      ...extraEnv,
    },
  });
  child.unref();
  return child.pid ?? -1;
}

async function runWorker(jobId, flags, prompt, root) {
  const plan = planRun(flags, root, jobId);
  updateJob(root, jobId, { pid: process.pid, model: plan.route.model });
  await executeWithRetries({ jobId, root, prompt, flags, plan });
}

/**
 * Default run flags for callers that build a run programmatically (fanout).
 *
 * @param {Partial<ReturnType<typeof parseFlags>>} [overrides]
 * @returns {ReturnType<typeof parseFlags>}
 */
export function defaultRunFlags(overrides = {}) {
  return {
    positional: [],
    model: undefined,
    background: false,
    wait: true,
    fresh: false,
    resume: undefined,
    force: true,
    cloud: false,
    timeoutRaw: undefined,
    noGitCheck: false,
    worker: undefined,
    type: DEFAULT_TASK_TYPE,
    retry: 0,
    worktree: false,
    worktreeName: undefined,
    worktreeBase: undefined,
    group: undefined,
    ...overrides,
  };
}

/**
 * Create the job record and run one delegated task to completion in this
 * process. This is the unit `/cursor:fanout` schedules in parallel.
 *
 * @param {Object} input
 * @param {string} input.root
 * @param {string} input.jobId
 * @param {string} input.prompt
 * @param {ReturnType<typeof parseFlags>} input.flags
 * @param {boolean=} input.background
 * @param {(ev: Record<string, unknown>) => void=} input.onEvent
 * @param {(line: string) => void=} input.log
 */
export async function runTaskJob({ root, jobId, prompt, flags, background = false, onEvent, log }) {
  const plan = planRun(flags, root, jobId);
  await createRecord(flags, prompt, jobId, root, plan, background);
  updateJob(root, jobId, { pid: process.pid });
  const outcome = await executeWithRetries({ jobId, root, prompt, flags, plan, onEvent, log });
  return { ...outcome, plan };
}

/**
 * Flags to hand a detached worker so it re-derives the same run.
 * @param {ReturnType<typeof parseFlags>} flags
 * @returns {string[]}
 */
export function forwardedWorkerArgs(flags) {
  const args = [];
  if (flags.model) args.push('--model', flags.model);
  if (flags.type !== DEFAULT_TASK_TYPE) args.push('--type', flags.type);
  if (flags.fresh) args.push('--fresh');
  if (flags.cloud) args.push('--cloud');
  if (flags.resume !== undefined) {
    if (typeof flags.resume === 'boolean') {
      if (flags.resume) args.push('--resume');
    } else {
      // String or numeric id — String() keeps a numeric id from being dropped.
      args.push(`--resume=${flags.resume}`);
    }
  }
  if (!flags.force) args.push('--no-force');
  if (flags.timeoutRaw !== undefined) args.push('--timeout', String(flags.timeoutRaw));
  if (flags.retry > 0) args.push('--retry', String(flags.retry));
  if (flags.worktree)
    args.push(flags.worktreeName ? `--worktree=${flags.worktreeName}` : '--worktree');
  if (flags.worktreeBase) args.push('--worktree-base', flags.worktreeBase);
  if (flags.group) args.push('--group', flags.group);
  return args;
}

/**
 * @param {string[]} rawArgv
 * @returns {Promise<number>}
 */
export async function main(rawArgv) {
  const flags = parseFlags(collapsePromptArgv(rawArgv, BOOLEAN_FLAGS));

  if (flags.worker) {
    // The prompt is handed over verbatim via env to avoid a second collapse
    // pass mangling quotes/backslashes; fall back to positional for safety.
    const prompt = process.env.CURSOR_PLUGIN_CC_PROMPT ?? flags.positional.join(' ').trim();
    const root = process.env.CURSOR_PLUGIN_CC_REPO_ROOT ?? (await repoRoot(process.cwd()));
    await runWorker(flags.worker, flags, prompt, root);
    return 0;
  }

  if (!isKnownTaskType(flags.type)) {
    process.stderr.write(
      `Error: unknown --type "${flags.type}". Use one of: ${TASK_TYPES.join(', ')}.\n`,
    );
    return 2;
  }

  const prompt = flags.positional.join(' ').trim();
  if (!prompt && !isResumeRequested(flags.resume, flags.fresh)) {
    process.stderr.write('Error: no task description provided.\n');
    process.stderr.write('Usage: /cursor:delegate [flags] <task>\n');
    return 2;
  }

  const inGit = await isGitRepo(process.cwd());
  if (!inGit && !flags.noGitCheck) {
    process.stderr.write(
      'Error: current directory is not a git repository. Pass --no-git-check to override.\n',
    );
    return 2;
  }
  if (!inGit && flags.worktree) {
    process.stderr.write('Error: --worktree needs a git repository.\n');
    return 2;
  }
  const root = await repoRoot(process.cwd());

  pruneOlderThanDays(root, 30);

  const jobId = newId(10);

  if (flags.background) {
    const plan = planRun(flags, root, jobId);
    await createRecord(flags, prompt || '(resume)', jobId, root, plan, true);
    if (plan.route.warning) process.stderr.write(`Warning: ${plan.route.warning}\n`);
    const extraEnv = prompt ? { CURSOR_PLUGIN_CC_PROMPT: prompt } : {};
    const pid = spawnBackground(jobId, forwardedWorkerArgs(flags), root, extraEnv);
    updateJob(root, jobId, { pid });
    process.stdout.write(
      `Job \`${jobId}\` started in background (${describeRun(flags, plan)}, pid ${pid}).\n`,
    );
    process.stdout.write(`Check progress with \`/cursor:status ${jobId}\`.\n`);
    return 0;
  }

  return foreground(flags, prompt || '(resume)', jobId, root);
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `delegate failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
