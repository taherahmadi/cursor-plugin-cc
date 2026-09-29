import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as diffMain } from '../scripts/diff.mjs';
import { diffSince, headCommit } from '../scripts/lib/git.mjs';
import { createJob, updateJob } from '../scripts/lib/jobs.mjs';
import { makeTempHome } from './helpers.mjs';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function initRepo(dir) {
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('diff', () => {
  let tmp;
  let repo;
  let out;
  let err;
  const prevHome = process.env.CURSOR_PLUGIN_CC_HOME;
  const prevCwd = process.cwd();
  let outSpy;
  let errSpy;

  beforeEach(() => {
    tmp = makeTempHome();
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
    // Keep the repo out of the plugin state dir so `jobs/` never shows up as
    // an untracked file in the diffs under test.
    repo = join(tmp.dir, 'repo');
    mkdirSync(repo);
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
    if (prevHome === undefined) delete process.env.CURSOR_PLUGIN_CC_HOME;
    else process.env.CURSOR_PLUGIN_CC_HOME = prevHome;
    tmp.cleanup();
  });

  it('headCommit returns null before the first commit', async () => {
    git(repo, ['init', '--quiet']);
    expect(await headCommit(repo)).toBeNull();
  });

  it('diffSince reports tracked edits and untracked files as additions', async () => {
    const base = initRepo(repo);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'new.txt'), 'brand new\n');
    const patch = await diffSince(repo, { base });
    expect(patch.isEmpty).toBe(false);
    expect(patch.files).toEqual(['a.txt', 'new.txt']);
    expect(patch.text).toMatch(/-one\n\+two/);
    expect(patch.text).toMatch(/\+brand new/);
    const stat = await diffSince(repo, { base, format: 'stat' });
    expect(stat.text).toMatch(/a\.txt/);
    expect(stat.text).toMatch(/\+ new\.txt \(new file\)/);
    const names = await diffSince(repo, { base, format: 'name-only' });
    expect(names.text).toBe('a.txt\nnew.txt\n');
  });

  it('diffSince flags a base that is not in the repo', async () => {
    initRepo(repo);
    const res = await diffSince(repo, { base: 'deadbeef' });
    expect(res.error).toMatch(/not in this repository/);
  });

  it('shows the latest job diff by default and resolves id prefixes', async () => {
    const base = initRepo(repo);
    createJob({ id: 'abcdef1234', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'abcdef1234', {
      status: 'done',
      baseCommit: base,
      workspacePath: repo,
    });
    writeFileSync(join(repo, 'a.txt'), 'changed by cursor\n');

    expect(await diffMain([])).toBe(0);
    expect(out).toMatch(/✓ done {2}job `abcdef1234`/);
    expect(out).toMatch(/```diff/);
    expect(out).toMatch(/\+changed by cursor/);

    out = '';
    expect(await diffMain(['abcd', '--stat'])).toBe(0);
    expect(out).toMatch(/a\.txt \|/);

    out = '';
    expect(await diffMain(['abcd', '--json'])).toBe(0);
    const json = JSON.parse(out);
    expect(json.files).toEqual(['a.txt']);
    expect(json.baseCommit).toBe(base);
  });

  it('reports no changes, unknown ids, and ambiguous prefixes', async () => {
    const base = initRepo(repo);
    for (const id of ['job-one', 'job-two']) {
      createJob({ id, repoPath: repo, prompt: 'p', model: 'm' });
      updateJob(repo, id, { status: 'done', baseCommit: base, workspacePath: repo });
    }
    expect(await diffMain(['job-one'])).toBe(0);
    expect(out).toMatch(/No changes since the job started/);

    expect(await diffMain(['job-'])).toBe(2);
    expect(err).toMatch(/ambiguous/);

    err = '';
    expect(await diffMain(['nope'])).toBe(1);
    expect(err).toMatch(/No job `nope`/);
  });

  it('diffs inside the job worktree when one was recorded', async () => {
    const base = initRepo(repo);
    const wt = join(repo, 'wt');
    git(repo, ['worktree', 'add', '--quiet', '-b', 'cursor-wt', wt]);
    writeFileSync(join(wt, 'a.txt'), 'edited in worktree\n');
    createJob({ id: 'wtjob', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'wtjob', {
      status: 'done',
      baseCommit: base,
      workspacePath: wt,
      worktreeName: 'cursor-wt',
      worktreePath: wt,
    });
    expect(await diffMain(['wtjob'])).toBe(0);
    expect(out).toMatch(/worktree `/);
    expect(out).toMatch(/\+edited in worktree/);
    expect(out).toMatch(/Bring it into your branch/);
  });

  it('errors cleanly with no jobs at all', async () => {
    initRepo(repo);
    expect(await diffMain([])).toBe(1);
    expect(err).toMatch(/No Cursor job with a recorded base commit/);
  });
});
