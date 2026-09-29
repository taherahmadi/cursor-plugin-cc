// Per-task-type model routing.
//
// A repo can pin which Cursor model handles which kind of work by dropping a
// `.cursor-plugin-cc.json` at its root:
//
//   {
//     "defaultModel": "composer",
//     "models": {
//       "implement": "composer",
//       "review": "gpt",
//       "security": "opus",
//       "plan": "opus",
//       "investigate": "auto"
//     },
//     "timeout": 1800
//   }
//
// Values accept the same aliases as `--model`. Resolution order for a run:
//   1. explicit `--model` on the command line
//   2. `models[<type>]` from the repo file
//   3. `defaultModel` from the repo file
//   4. `CURSOR_PLUGIN_CC_DEFAULT_MODEL` env, then the built-in `auto`
//
// Task types also carry an execution mode: `plan` and `investigate` are
// read-only by definition, so they run cursor-agent in `--mode plan` /
// `--mode ask` and can never touch the tree, whatever the prompt says.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModel } from './cursor.mjs';

export const REPO_CONFIG_FILE = '.cursor-plugin-cc.json';

/** @type {readonly string[]} */
export const TASK_TYPES = Object.freeze([
  'implement',
  'review',
  'plan',
  'investigate',
  'security',
  'browser',
]);

/** Cursor CLI `--mode` per task type; undefined means the default (agent) mode. */
const TYPE_MODES = Object.freeze({
  plan: 'plan',
  investigate: 'ask',
});

/**
 * @typedef {Object} RepoConfig
 * @property {string=} defaultModel
 * @property {Record<string, string>=} models
 * @property {number=} timeout
 */

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoConfigPath(repoRoot) {
  return join(repoRoot, REPO_CONFIG_FILE);
}

/**
 * Read and lightly validate the repo config. Malformed JSON or a non-object
 * yields `{}` plus a warning string, so a typo never breaks delegation.
 *
 * @param {string} repoRoot
 * @returns {{config: RepoConfig, warning?: string}}
 */
export function readRepoConfig(repoRoot) {
  const file = repoConfigPath(repoRoot);
  if (!existsSync(file)) return { config: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      config: {},
      warning: `${REPO_CONFIG_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ignoring it.`,
    };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, warning: `${REPO_CONFIG_FILE} must contain a JSON object — ignoring it.` };
  }
  /** @type {RepoConfig} */
  const config = {};
  if (typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim()) {
    config.defaultModel = parsed.defaultModel.trim();
  }
  if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
    /** @type {Record<string, string>} */
    const models = {};
    for (const [k, v] of Object.entries(parsed.models)) {
      if (typeof v === 'string' && v.trim()) models[k.trim().toLowerCase()] = v.trim();
    }
    config.models = models;
  }
  if (typeof parsed.timeout === 'number' && Number.isFinite(parsed.timeout) && parsed.timeout > 0) {
    config.timeout = parsed.timeout;
  }
  return { config };
}

/**
 * @param {unknown} raw
 * @returns {string|undefined}  Normalised task type, or undefined when unset.
 */
export function normaliseTaskType(raw) {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  return t.length > 0 ? t : undefined;
}

/**
 * @param {string|undefined} type
 * @returns {boolean}
 */
export function isKnownTaskType(type) {
  return type !== undefined && TASK_TYPES.includes(type);
}

/**
 * @typedef {Object} RouteInput
 * @property {string=} explicitModel   The `--model` value, if any.
 * @property {string=} type            Task type (`implement`, `review`, …).
 * @property {string} repoRoot
 */

/**
 * @typedef {Object} Route
 * @property {string} model            Resolved real Cursor model id.
 * @property {'explicit'|'type'|'repo-default'|'env-default'|'builtin'} source
 * @property {string=} mode            Cursor `--mode` to run with, if any.
 * @property {number=} timeout         Repo-level default timeout in seconds.
 * @property {string=} warning
 */

/**
 * Resolve the model (and execution mode) for a run.
 *
 * @param {RouteInput} input
 * @returns {Route}
 */
export function resolveRoute(input) {
  const { config, warning } = readRepoConfig(input.repoRoot);
  const type = normaliseTaskType(input.type);
  const mode = type ? TYPE_MODES[type] : undefined;
  const base = { ...(mode ? { mode } : {}), ...(config.timeout ? { timeout: config.timeout } : {}) };
  const withWarning = (route) => (warning ? { ...route, warning } : route);

  if (typeof input.explicitModel === 'string' && input.explicitModel.trim()) {
    return withWarning({ ...base, model: resolveModel(input.explicitModel), source: 'explicit' });
  }
  if (type && config.models && config.models[type]) {
    return withWarning({ ...base, model: resolveModel(config.models[type]), source: 'type' });
  }
  if (config.defaultModel) {
    return withWarning({
      ...base,
      model: resolveModel(config.defaultModel),
      source: 'repo-default',
    });
  }
  const envDefault = process.env.CURSOR_PLUGIN_CC_DEFAULT_MODEL;
  return withWarning({
    ...base,
    model: resolveModel(undefined),
    source: envDefault && envDefault.trim() ? 'env-default' : 'builtin',
  });
}
