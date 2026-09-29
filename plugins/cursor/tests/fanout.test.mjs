import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as fanoutMain, parseParallel } from '../scripts/fanout.mjs';
import { listGroups, parseTasks, readGroup } from '../scripts/lib/groups.mjs';
import { listGroupJobs, listJobs } from '../scripts/lib/jobs.mjs';
import { REPO_CONFIG_FILE } from '../scripts/lib/routing.mjs';
import { main as statusMain } from '../scripts/status.mjs';
import { FAILURE_FIXTURE, HAPPY_FIXTURE, STUB_BIN, makeTempHome } from './helpers.mjs';

const ENV_KEYS = [
  'CURSOR_PLUGIN_CC_HOME',
  'CURSOR_AGENT_BIN',
  'CURSOR_AGENT_STUB_FIXTURE',
  'CURSOR_AGENT_STUB_SEQUENCE',
  'CURSOR_AGENT_STUB_COUNTER',
  'CURSOR_AGENT_STUB_ARGS_OUT',
  'CURSOR_AGENT_STUB_DELAY_MS',
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
}

describe('parseTasks', () => {
  it('splits inline tasks on ;; and strips known type prefixes only', () => {
    const tasks = parseTasks(
      'add tests ;; review: check auth ;; note: keep http://x ;; Security: scan',
    );
    expect(tasks).toEqual([
      { type: 'implement', prompt: 'add tests' },
      { type: 'review', prompt: 'check auth' },
      { type: 'implement', prompt: 'note: keep http://x' },
      { type: 'security', prompt: 'scan' },
    ]);
  });

  it('splits file input on blank lines or --- and honours the default type', () => {
    const body = 'plan: think\n\nimplement it\n---\ninvestigate: why slow\n';
    expect(parseTasks(body, { fromFile: true, defaultType: 'review' })).toEqual([
      { type: 'plan', prompt: 'think' },
      { type: 'review', prompt: 'implement it' },
      { type: 'investigate', prompt: 'why slow' },
    ]);
  });

  it('parseParallel clamps', () => {
    expect(parseParallel(undefined)).toBe(4);
    expect(parseParallel('x', 3)).toBe(3);
    expect(parseParallel(0)).toBe(4);
    expect(parseParallel(99)).toBe(16);
    expect(parseParallel('2')).toBe(2);
  });
});

describe('fanout', () => {
  let tmp;
  let repo;
  let argsOut;
  let out;
  let err;
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  let outSpy;
  let errSpy;

  beforeEach(() => {
    tmp = makeTempHome();
    repo = join(tmp.dir, 'repo');
    mkdirSync(repo);
    argsOut = join(tmp.dir, 'calls.jsonl');
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
    process.env.CURSOR_AGENT_BIN = STUB_BIN;
    process.env.CURSOR_AGENT_STUB_FIXTURE = HAPPY_FIXTURE;
    process.env.CURSOR_AGENT_STUB_ARGS_OUT = argsOut;
    process.chdir(repo);
    out = '';
    err = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += s;
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err += s;
      return true;
    });
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

  it('runs tasks in parallel, tags them with a group, and prints a synthesis', async () => {
    initRepo(repo);
    writeFileSync(join(repo, REPO_CONFIG_FILE), JSON.stringify({ models: { review: 'gpt' } }));
    process.env.CURSOR_AGENT_STUB_DELAY_MS = '300';
    const started = Date.now();
    const code = await fanoutMain(['--parallel', '3', '--', 'one ;; two ;; review: three']);
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    // Three 300 ms tasks with parallel=3 should take well under 3×300 ms.
    expect(elapsed).toBeLessThan(800);

    const groups = listGroups(repo);
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group.status).toBe('done');
    expect(group.tasks.length).toBe(3);
    const jobs = listGroupJobs(repo, group.id);
    expect(jobs.length).toBe(3);
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
    const review = jobs.find((j) => j.taskType === 'review');
    expect(review.model).toBe('gpt-5.3-codex');
    expect(review.worktreeName).toBeUndefined();
    const implement = jobs.filter((j) => j.taskType === 'implement');
    expect(implement.length).toBe(2);
    // Writers isolate by default.
    expect(implement.every((j) => j.worktreeName === `cursor-${j.id}`)).toBe(true);
    const calls = readCalls(argsOut);
    expect(calls.length).toBe(3);
    expect(calls.filter((c) => c.argv.includes('--worktree')).length).toBe(2);

    expect(out).toMatch(/### Fanout `/);
    expect(out).toMatch(/\| 3 \| review \|/);
    expect(out).toMatch(/3 task\(s\):\*\* 3 done, 0 failed/);
    expect(out).toMatch(/speedup/);
  });

  it('respects the concurrency bound', async () => {
    initRepo(repo);
    process.env.CURSOR_AGENT_STUB_DELAY_MS = '250';
    const started = Date.now();
    const code = await fanoutMain(['--parallel', '1', '--no-worktree', '--', 'a ;; b']);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(480);
    expect(readCalls(argsOut).every((c) => !c.argv.includes('--worktree'))).toBe(true);
  });

  it('reports failures, exits 1, and --collect re-prints the synthesis', async () => {
    initRepo(repo);
    process.env.CURSOR_AGENT_STUB_COUNTER = join(tmp.dir, 'counter');
    process.env.CURSOR_AGENT_STUB_SEQUENCE = `${FAILURE_FIXTURE},${HAPPY_FIXTURE}`;
    const code = await fanoutMain(['--parallel', '1', '--no-worktree', '--', 'bad ;; good']);
    expect(code).toBe(1);
    const group = listGroups(repo)[0];
    expect(out).toMatch(/2 task\(s\):\*\* 1 done, 1 failed/);

    out = '';
    expect(await fanoutMain(['--collect', group.id.slice(0, 4)])).toBe(0);
    expect(out).toMatch(new RegExp(`### Fanout \`${group.id}\` — done`));

    out = '';
    expect(await statusMain(['--group', group.id])).toBe(0);
    expect(out).toMatch(/\| ID \| Status \| Type \|/);
    expect(out.split('\n').filter((l) => l.startsWith('| `')).length).toBe(2);
  });

  it('reads tasks from a file and applies --retry to every task', async () => {
    initRepo(repo);
    const file = join(tmp.dir, 'tasks.md');
    writeFileSync(file, 'plan: think about it\n\nimplement: do it\n');
    const code = await fanoutMain([
      '--tasks-file',
      file,
      '--retry',
      '2',
      '--no-worktree',
      '--parallel',
      '2',
    ]);
    expect(code).toBe(0);
    const jobs = listJobs(repo);
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.retryMax === 2)).toBe(true);
    const plan = jobs.find((j) => j.taskType === 'plan');
    expect(plan.mode).toBe('plan');
  });

  it('errors on empty input, bad type, and non-git dirs', async () => {
    expect(await fanoutMain([])).toBe(2);
    expect(err).toMatch(/no tasks given/);
    err = '';
    expect(await fanoutMain(['--type', 'nope', '--', 'x'])).toBe(2);
    err = '';
    expect(await fanoutMain(['--', 'x ;; y'])).toBe(2);
    expect(err).toMatch(/not a git repository/);
    expect(listGroups(repo).length).toBe(0);
  });

  it('background mode writes the group and spawns a worker', async () => {
    initRepo(repo);
    const code = await fanoutMain([
      '--background',
      '--no-worktree',
      '--parallel',
      '2',
      '--',
      'p ;; q',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/Running in background/);
    const group = listGroups(repo)[0];
    expect(group.background).toBe(true);
    // Give the detached worker a moment to finish both stub runs.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && readGroup(repo, group.id)?.status !== 'done') {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readGroup(repo, group.id)?.status).toBe('done');
    expect(listGroupJobs(repo, group.id).every((j) => j.status === 'done')).toBe(true);
  });
});
