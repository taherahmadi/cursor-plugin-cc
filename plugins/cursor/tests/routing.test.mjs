import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_CONFIG_FILE,
  TASK_TYPES,
  isKnownTaskType,
  normaliseTaskType,
  readRepoConfig,
  resolveRoute,
} from '../scripts/lib/routing.mjs';
import { makeTempHome } from './helpers.mjs';

describe('routing', () => {
  let tmp;
  const prevDefault = process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;

  beforeEach(() => {
    tmp = makeTempHome();
    delete process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
  });

  afterEach(() => {
    if (prevDefault === undefined) delete process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
    else process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = prevDefault;
    tmp.cleanup();
  });

  const writeConfig = (obj) =>
    writeFileSync(
      join(tmp.dir, REPO_CONFIG_FILE),
      typeof obj === 'string' ? obj : JSON.stringify(obj),
    );

  it('falls back to the builtin default without a repo file', () => {
    const route = resolveRoute({ repoRoot: tmp.dir, type: 'implement' });
    expect(route.model).toBe('auto');
    expect(route.source).toBe('builtin');
    expect(route.mode).toBeUndefined();
  });

  it('routes by task type and resolves aliases', () => {
    writeConfig({ models: { implement: 'composer', review: 'gpt', Security: 'opus' } });
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'implement' })).toMatchObject({
      model: 'composer-2.5-fast',
      source: 'type',
    });
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'review' }).model).toBe('gpt-5.3-codex');
    // keys are case-insensitive
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'security' }).model).toBe(
      'claude-opus-4-7-high',
    );
  });

  it('explicit --model beats the type route', () => {
    writeConfig({ models: { implement: 'composer' } });
    const route = resolveRoute({ repoRoot: tmp.dir, type: 'implement', explicitModel: 'opus' });
    expect(route.model).toBe('claude-opus-4-7-high');
    expect(route.source).toBe('explicit');
  });

  it('repo defaultModel beats the env default, env beats builtin', () => {
    process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL = 'gpt';
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'implement' })).toMatchObject({
      model: 'gpt-5.3-codex',
      source: 'env-default',
    });
    writeConfig({ defaultModel: 'sonnet' });
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'implement' })).toMatchObject({
      model: 'claude-4.6-sonnet-medium',
      source: 'repo-default',
    });
  });

  it('plan and investigate types carry read-only Cursor modes', () => {
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'plan' }).mode).toBe('plan');
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'investigate' }).mode).toBe('ask');
    expect(resolveRoute({ repoRoot: tmp.dir, type: 'implement' }).mode).toBeUndefined();
    expect(resolveRoute({ repoRoot: tmp.dir }).mode).toBeUndefined();
  });

  it('surfaces a repo-level timeout', () => {
    writeConfig({ timeout: 900 });
    expect(resolveRoute({ repoRoot: tmp.dir }).timeout).toBe(900);
    writeConfig({ timeout: -5 });
    expect(resolveRoute({ repoRoot: tmp.dir }).timeout).toBeUndefined();
  });

  it('ignores malformed config with a warning instead of failing', () => {
    writeConfig('{ not json');
    const { config, warning } = readRepoConfig(tmp.dir);
    expect(config).toEqual({});
    expect(warning).toMatch(/not valid JSON/);
    const route = resolveRoute({ repoRoot: tmp.dir, type: 'implement' });
    expect(route.model).toBe('auto');
    expect(route.warning).toMatch(/not valid JSON/);

    writeConfig('[1,2]');
    expect(readRepoConfig(tmp.dir).warning).toMatch(/JSON object/);
  });

  it('normalises and validates task types', () => {
    expect(normaliseTaskType('  Review ')).toBe('review');
    expect(normaliseTaskType(undefined)).toBeUndefined();
    expect(normaliseTaskType('')).toBeUndefined();
    expect(isKnownTaskType('implement')).toBe(true);
    expect(isKnownTaskType('bogus')).toBe(false);
    expect(TASK_TYPES).toContain('security');
  });
});
