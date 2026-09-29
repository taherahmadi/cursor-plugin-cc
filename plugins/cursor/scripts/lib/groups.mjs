// Fanout groups: one record per `/cursor:fanout` run, kept beside the jobs it
// spawned (`<state-root>/jobs/<repo-hash>/groups/<group-id>.json`). Jobs point
// back via `groupId`, so either side can find the other.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listGroupJobs } from './jobs.mjs';
import { jobsDir } from './paths.mjs';
import { TASK_TYPES } from './routing.mjs';

/**
 * @typedef {Object} GroupTask
 * @property {number} index
 * @property {string} jobId
 * @property {string} type
 * @property {string} prompt
 */

/**
 * @typedef {Object} GroupRecord
 * @property {string} id
 * @property {string} repoPath
 * @property {string} createdAt
 * @property {string=} finishedAt
 * @property {number} parallel
 * @property {'running'|'done'} status
 * @property {GroupTask[]} tasks
 * @property {boolean=} background
 * @property {number=} pid
 */

/** @param {string} repoPath */
export function groupsDir(repoPath) {
  return join(jobsDir(repoPath), 'groups');
}

/**
 * @param {string} repoPath
 * @param {string} id
 */
export function groupFilePath(repoPath, id) {
  return join(groupsDir(repoPath), `${id}.json`);
}

/**
 * @param {string} repoPath
 * @param {GroupRecord} record
 * @returns {GroupRecord}
 */
export function writeGroup(repoPath, record) {
  mkdirSync(groupsDir(repoPath), { recursive: true });
  writeFileSync(groupFilePath(repoPath, record.id), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @returns {GroupRecord|null}
 */
export function readGroup(repoPath, id) {
  const file = groupFilePath(repoPath, id);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @param {Partial<GroupRecord>} patch
 * @returns {GroupRecord|null}
 */
export function updateGroup(repoPath, id, patch) {
  const existing = readGroup(repoPath, id);
  if (!existing) return null;
  return writeGroup(repoPath, { ...existing, ...patch });
}

/**
 * Newest first.
 * @param {string} repoPath
 * @returns {GroupRecord[]}
 */
export function listGroups(repoPath) {
  const dir = groupsDir(repoPath);
  if (!existsSync(dir)) return [];
  /** @type {GroupRecord[]} */
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const rec = readGroup(repoPath, f.slice(0, -5));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Resolve a group id by exact match or unique prefix.
 * @param {string} repoPath
 * @param {string} ref
 * @returns {{group: GroupRecord|null, ambiguous?: GroupRecord[]}}
 */
export function resolveGroupRef(repoPath, ref) {
  const exact = readGroup(repoPath, ref);
  if (exact) return { group: exact };
  const matches = listGroups(repoPath).filter((g) => g.id.startsWith(ref));
  if (matches.length === 1) return { group: matches[0] };
  if (matches.length > 1) return { group: null, ambiguous: matches };
  return { group: null };
}

/**
 * Split a fanout body into tasks. Inline: tasks are separated by `;;`.
 * From a file: by blank lines or a `---` line. A task may start with
 * `<type>:` (one of TASK_TYPES) to pick its route; only a KNOWN type prefix
 * is stripped, so `http://…` or `note: …` stay part of the prompt.
 *
 * @param {string} body
 * @param {{fromFile?: boolean, defaultType?: string}} [opts]
 * @returns {{type: string, prompt: string}[]}
 */
export function parseTasks(body, opts = {}) {
  const defaultType = opts.defaultType ?? 'implement';
  const chunks = opts.fromFile
    ? body.split(/\n\s*(?:---+\s*)?\n|\n---+\s*\n/)
    : body.split(/\s*;;\s*/);
  /** @type {{type: string, prompt: string}[]} */
  const tasks = [];
  for (const raw of chunks) {
    const text = raw.trim();
    if (!text) continue;
    const m = /^([A-Za-z]+)\s*:\s*([\s\S]+)$/.exec(text);
    if (m && TASK_TYPES.includes(m[1].toLowerCase()) && m[2].trim()) {
      tasks.push({ type: m[1].toLowerCase(), prompt: m[2].trim() });
    } else {
      tasks.push({ type: defaultType, prompt: text });
    }
  }
  return tasks;
}

/**
 * @param {string} repoPath
 * @param {GroupRecord} group
 */
export function groupJobs(repoPath, group) {
  const byId = new Map(listGroupJobs(repoPath, group.id).map((j) => [j.id, j]));
  return group.tasks.map((t) => ({ task: t, job: byId.get(t.jobId) ?? null }));
}
