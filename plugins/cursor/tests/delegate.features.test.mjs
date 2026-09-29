import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forwardedWorkerArgs,
  main as delegateMain,
  parseRetry,
  retryPrompt,
} from '../scripts/delegate.mjs';
import { listJobs } from '../scripts/lib/jobs.mjs';
import { REPO_CONFIG_FILE } from '../scripts/lib/routing.mjs';
import { FAILURE_FIXTURE, HAPPY_FIXTURE, STUB_BIN, makeTempHome } from './helpers.mjs';

const ENV_KEYS = [
  'CURSOR_PLUGIN_CC_HOME',
  'CURSOR_AGENT_BIN',
  'CURSOR_AGENT_STUB_FIXTURE',
  'CURSOR_AGENT_STUB_SEQUENCE',
  'CURSOR_AGENT_STUB_COUNTER',
  'CURSOR_AGENT_STUB_ARGS_OUT',
  'CURSOR_PLUGIN_CC_CURSOR_WORKTREES',
  'CURSOR_PLUGIN_CC_DEFAULT_MODEL',
];

function readCalls(argsOut) {
  if (!existsSync(argsOut)) return [];
  return readFileSync(argsOut, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function initRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'init']);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

describe('delegate: routing, retry, worktree', () => {
  let tmp;
  let argsOut;
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  let outSpy;
  let errSpy;

  beforeEach(() => {
    tmp = makeTempHome();
    argsOut = join(tmp.dir, 'calls.jsonl');
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
    process.env.CURSOR_AGENT_BIN = STUB_BIN;
    process.env.CURSOR_AGENT_STUB_FIXTURE = HAPPY_FIXTURE;
    process.env.CURSOR_AGENT_STUB_ARGS_OUT = argsOut;
    process.env.CURSOR_AGENT_STUB_COUNTER = join(tmp.dir, 'counter');
    process.chdir(tmp.dir);
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    tmp.cleanup();
  });

  it('parseRetry clamps junk and caps the count', () => {
    expect(parseRetry(undefined)).toBe(0);
    expect(parseRetry('abc')).toBe(0);
    expect(parseRetry(-3)).toBe(0);
    expect(parseRetry(2)).toBe(2);
    expect(parseRetry('3')).toBe(3);
    expect(parseRetry(99)).toBe(10);
  });

  it('routes the model by --type from the repo config and records the type', async () => {
    writeFileSync(
      join(tmp.dir, REPO_CONFIG_FILE),
      JSON.stringify({ models: { security: 'opus', implement: 'composer' } }),
    );
    const code = await delegateMain(['--no-git-check', '--type', 'security', '--', 'audit auth']);
    expect(code).toBe(0);
    const job = listJobs(tmp.dir)[0];
    expect(job.model).toBe('claude-opus-4-7-high');
    expect(job.taskType).toBe('security');
    expect(job.routeSource).toBe('type');
    expect(job.workspacePath).toBe(tmp.dir);
    const [call] = readCalls(argsOut);
    expect(call.argv).toContain('claude-opus-4-7-high');
  });

  it('plan type runs read-only via --mode plan', async () => {
    const code = await delegateMain([
      '--no-git-check',
      '--type',
      'plan',
      '--',
      'how should we do X',
    ]);
    expect(code).toBe(0);
    const [call] = readCalls(argsOut);
    const i = call.argv.indexOf('--mode');
    expect(i).toBeGreaterThan(-1);
    expect(call.argv[i + 1]).toBe('plan');
    expect(listJobs(tmp.dir)[0].mode).toBe('plan');
  });

  it('rejects an unknown --type with exit 2', async () => {
    const code = await delegateMain(['--no-git-check', '--type', 'bogus', '--', 'x']);
    expect(code).toBe(2);
    expect(listJobs(tmp.dir).length).toBe(0);
  });

  it('--retry resumes the same chat after a failure and then succeeds', async () => {
    process.env.CURSOR_AGENT_STUB_SEQUENCE = `${FAILURE_FIXTURE},${HAPPY_FIXTURE}`;
    const code = await delegateMain(['--no-git-check', '--retry', '2', '--', 'flaky task']);
    expect(code).toBe(0);
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(2);
    expect(job.retryMax).toBe(2);
    expect(job.summary).toMatch(/2 attempts/);
    const calls = readCalls(argsOut);
    expect(calls.length).toBe(2);
    expect(calls[0].argv.some((a) => a.startsWith('--resume'))).toBe(false);
    // Second attempt resumes the chat the failed attempt reported.
    expect(calls[1].argv).toContain('--resume=chat_fail_999');
    expect(calls[1].prompt).toMatch(/previous attempt/i);
    expect(calls[1].prompt).toContain('flaky task');
    // Both attempts land in one NDJSON log, separated by a marker.
    expect(readFileSync(job.rawLogPath, 'utf8')).toMatch(/# attempt 2/);
  });

  it('--retry gives up after N extra attempts and stays failed', async () => {
    process.env.CURSOR_AGENT_STUB_SEQUENCE = FAILURE_FIXTURE;
    const code = await delegateMain(['--no-git-check', '--retry', '1', '--', 'doomed']);
    expect(code).not.toBe(0);
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(readCalls(argsOut).length).toBe(2);
  });

  it('without --retry a failure is a single attempt', async () => {
    process.env.CURSOR_AGENT_STUB_SEQUENCE = FAILURE_FIXTURE;
    await delegateMain(['--no-git-check', '--', 'once']);
    const job = listJobs(tmp.dir)[0];
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.retryMax).toBeUndefined();
    expect(readCalls(argsOut).length).toBe(1);
  });

  it('--worktree passes cursor-agent --worktree and records the resolved path', async () => {
    const sha = initRepo(tmp.dir);
    const wtRoot = join(tmp.dir, 'cursor-worktrees');
    process.env.CURSOR_PLUGIN_CC_CURSOR_WORKTREES = wtRoot;
    const code = await delegateMain(['--worktree', '--', 'isolated change']);
    expect(code).toBe(0);
    const job = listJobs(tmp.dir)[0];
    expect(job.baseCommit).toBe(sha);
    expect(job.worktreeName).toBe(`cursor-${job.id}`);
    const [call] = readCalls(argsOut);
    const i = call.argv.indexOf('--worktree');
    expect(i).toBeGreaterThan(-1);
    expect(call.argv[i + 1]).toBe(`cursor-${job.id}`);
    // The stub does not create the tree, so the path stays unresolved …
    expect(job.worktreePath).toBeUndefined();
    expect(job.workspacePath).toBe(tmp.dir);
    // … but when cursor-agent does, the documented location is picked up.
    const created = join(wtRoot, 'repo-name-does-not-matter', `cursor-${job.id}`);
    mkdirSync(created, { recursive: true });
    const { resolveWorktreePath } = await import('../scripts/lib/worktree.mjs');
    expect(resolveWorktreePath({ repoRoot: tmp.dir, name: `cursor-${job.id}` })).toBe(created);
  });

  it('--worktree=<name> keeps a custom name and refuses outside git', async () => {
    let code = await delegateMain(['--no-git-check', '--worktree=feature-x', '--', 'named']);
    expect(code).toBe(2); // not a git repo
    initRepo(tmp.dir);
    code = await delegateMain(['--worktree=feature-x', '--', 'named']);
    expect(code).toBe(0);
    expect(listJobs(tmp.dir)[0].worktreeName).toBe('feature-x');
    expect(listJobs(tmp.dir)[0].prompt).toBe('named');
  });

  it('forwards the new flags to a background worker', () => {
    const args = forwardedWorkerArgs({
      model: 'opus',
      type: 'security',
      fresh: false,
      cloud: false,
      resume: undefined,
      force: true,
      timeoutRaw: 60,
      retry: 3,
      worktree: true,
      worktreeName: 'wt-1',
      worktreeBase: 'main',
      group: 'grp1',
    });
    expect(args).toEqual([
      '--model',
      'opus',
      '--type',
      'security',
      '--timeout',
      '60',
      '--retry',
      '3',
      '--worktree=wt-1',
      '--worktree-base',
      'main',
      '--group',
      'grp1',
    ]);
  });

  it('retryPrompt keeps the original task verbatim', () => {
    const p = retryPrompt('exit code 1', 'do the thing');
    expect(p).toMatch(/exit code 1/);
    expect(p.endsWith('do the thing')).toBe(true);
  });
});
