import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, updateJob } from '../scripts/lib/jobs.mjs';
import { installStatusline, settingsPath } from '../scripts/lib/statusline-install.mjs';
import { main as setupMain } from '../scripts/setup.mjs';
import {
  currentDirFrom,
  fmtElapsed,
  renderStatusline,
  statuslineFor,
} from '../scripts/statusline.mjs';
import { makeTempHome } from './helpers.mjs';

const STATUSLINE_BIN = new URL('../scripts/statusline.mjs', import.meta.url).pathname;

function runWidget(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUSLINE_BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('statusline widget', () => {
  let tmp;
  let repo;
  const prevHome = process.env.CURSOR_PLUGIN_CC_HOME;
  const prevSettings = process.env.CURSOR_PLUGIN_CC_CLAUDE_SETTINGS;

  beforeEach(() => {
    tmp = makeTempHome();
    repo = join(tmp.dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    process.env.CURSOR_PLUGIN_CC_HOME = tmp.dir;
    process.env.CURSOR_PLUGIN_CC_CLAUDE_SETTINGS = join(tmp.dir, 'claude', 'settings.json');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CURSOR_PLUGIN_CC_HOME;
    else process.env.CURSOR_PLUGIN_CC_HOME = prevHome;
    if (prevSettings === undefined) delete process.env.CURSOR_PLUGIN_CC_CLAUDE_SETTINGS;
    else process.env.CURSOR_PLUGIN_CC_CLAUDE_SETTINGS = prevSettings;
    tmp.cleanup();
  });

  it('formats elapsed time', () => {
    expect(fmtElapsed(5)).toBe('5s');
    expect(fmtElapsed(83)).toBe('1m 23s');
    expect(fmtElapsed(7_440)).toBe('2h 4m');
  });

  it('prefers workspace.current_dir over cwd', () => {
    expect(currentDirFrom({ workspace: { current_dir: '/a' }, cwd: '/b' })).toBe('/a');
    expect(currentDirFrom({ cwd: '/b' })).toBe('/b');
    expect(currentDirFrom({})).toBe(process.cwd());
  });

  it('renders nothing when idle and a spinner line when jobs run', () => {
    expect(renderStatusline([])).toBe('');
    const now = Date.now();
    const jobs = [
      {
        id: 'a',
        status: 'running',
        startedAt: new Date(now - 192_000).toISOString(),
        pid: process.pid,
      },
      {
        id: 'b',
        status: 'running',
        startedAt: new Date(now - 5_000).toISOString(),
        pid: process.pid,
      },
      { id: 'c', status: 'done', startedAt: new Date(now - 900_000).toISOString() },
    ];
    const line = renderStatusline(jobs, now);
    expect(line).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 2 cursor · 3m 12s$/);
    // Crashed jobs (running record, dead pid) are not counted.
    const crashed = [
      { id: 'z', status: 'running', startedAt: new Date(now).toISOString(), pid: 2 ** 22 - 1 },
    ];
    expect(renderStatusline(crashed, now)).toBe('');
    // Fanout groups are called out.
    const grouped = jobs.map((j) => ({ ...j, groupId: 'g1' }));
    expect(renderStatusline(grouped, now)).toMatch(/2 cursor \(1 fanout\)/);
  });

  it('scopes to the repo of the directory Claude Code reports', async () => {
    createJob({ id: 'live', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'live', { pid: process.pid });
    const here = await statuslineFor({ workspace: { current_dir: repo } });
    expect(here).toMatch(/1 cursor/);
    const elsewhere = join(tmp.dir, 'other');
    mkdirSync(elsewhere);
    execFileSync('git', ['init', '--quiet'], { cwd: elsewhere });
    expect(await statuslineFor({ workspace: { current_dir: elsewhere } })).toBe('');
  });

  it('runs as a process: reads stdin JSON, prints one line, exits 0', async () => {
    createJob({ id: 'live', repoPath: repo, prompt: 'p', model: 'm' });
    updateJob(repo, 'live', { pid: process.pid });
    const res = await runWidget(
      { cwd: repo },
      { CURSOR_PLUGIN_CC_HOME: tmp.dir, FORCE_COLOR: '0' },
    );
    expect(res.code).toBe(0);
    expect(res.out.trim()).toMatch(/1 cursor/);
    const idle = await runWidget({ cwd: tmp.dir }, { CURSOR_PLUGIN_CC_HOME: tmp.dir });
    expect(idle.out).toBe('');
  });

  it('installs into an empty settings file, refuses to clobber an existing status line', () => {
    let res = installStatusline();
    expect(res.outcome).toBe('installed');
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.statusLine.type).toBe('command');
    expect(written.statusLine.command).toMatch(/statusline\.mjs/);
    expect(installStatusline().outcome).toBe('already-ours');

    writeFileSync(
      settingsPath(),
      JSON.stringify({ statusLine: { type: 'command', command: '~/my-bar.sh' }, other: 1 }),
    );
    res = installStatusline();
    expect(res.outcome).toBe('conflict');
    expect(res.existing).toBe('~/my-bar.sh');
    // Untouched.
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8')).other).toBe(1);
  });

  it('setup --statusline prints the snippet and --install-statusline reports the outcome', async () => {
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += s;
      return true;
    });
    try {
      expect(await setupMain(['--statusline'])).toBe(0);
      expect(out).toMatch(/"statusLine"/);
      expect(out).toMatch(/--install-statusline/);
      out = '';
      expect(await setupMain(['--install-statusline'])).toBe(0);
      expect(out).toMatch(/installed/);
      out = '';
      writeFileSync(
        settingsPath(),
        JSON.stringify({ statusLine: { type: 'command', command: 'x' } }),
      );
      expect(await setupMain(['--install-statusline'])).toBe(1);
      expect(out).toMatch(/Not overwriting/);
    } finally {
      spy.mockRestore();
    }
  });
});
