import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { killTree } from './kill.mjs';
import { ensureDir, jobsDir, logsDir } from './paths.mjs';

/**
 * Set by the SessionStart hook (via CLAUDE_ENV_FILE), so every job created
 * from a Claude Code session carries the id of the session that started it.
 */
export const SESSION_ID_ENV = 'CURSOR_PLUGIN_CC_SESSION_ID';

/**
 * @typedef {'running'|'done'|'failed'|'cancelled'} JobStatus
 */

/**
 * @typedef {Object} JobRecord
 * @property {string} id
 * @property {string} repoPath
 * @property {string} prompt
 * @property {string} model
 * @property {string=} cursorChatId
 * @property {number=} pid
 * @property {JobStatus} status
 * @property {number=} exitCode
 * @property {string} startedAt
 * @property {string=} finishedAt
 * @property {string} rawLogPath
 * @property {string=} summary
 * @property {string[]=} filesTouched
 * @property {boolean=} background
 * @property {boolean=} cloud
 * @property {string=} sessionId
 * @property {import('./review-output.mjs').ReviewOutput=} review
 * @property {string=} taskType        implement | review | plan | investigate | security | browser
 * @property {string=} routeSource     Where the model came from (explicit, type, repo-default, …).
 * @property {string=} mode            Cursor `--mode` the run used, if any.
 * @property {number=} retryMax        Extra attempts allowed by `--retry`.
 * @property {number=} attempts        Attempts actually made.
 * @property {number=} childPid        The live cursor-agent pid while running.
 * @property {string=} baseCommit      HEAD when the job started (what `/cursor:diff` diffs against).
 * @property {string=} workspacePath   Where the agent worked: the repo root, or the worktree.
 * @property {string=} worktreeName    cursor-agent `--worktree` name, when isolated.
 * @property {string=} worktreePath    Resolved worktree path, when isolated.
 * @property {string=} groupId         `/cursor:fanout` group this job belongs to.
 */

/**
 * @typedef {Object} CreateJobInit
 * @property {string} id
 * @property {string} repoPath
 * @property {string} prompt
 * @property {string} model
 * @property {boolean=} background
 * @property {boolean=} cloud
 * @property {string=} sessionId
 */

/**
 * @param {string} repoPath
 * @param {string} id
 */
export function jobFilePath(repoPath, id) {
  return join(jobsDir(repoPath), `${id}.json`);
}

/**
 * @param {string} repoPath
 * @param {string} id
 */
export function rawLogPath(repoPath, id) {
  return join(logsDir(repoPath), `${id}.ndjson`);
}

function atomicWrite(target, data) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    // Don't leave the temp file behind if the rename fails.
    try {
      unlinkSync(tmp);
    } catch {
      // noop
    }
    throw err;
  }
}

/**
 * @param {CreateJobInit} init
 * @returns {JobRecord}
 */
export function createJob(init) {
  ensureDir(jobsDir(init.repoPath));
  ensureDir(logsDir(init.repoPath));
  // Stamp the owning Claude session so /cursor:status can scope its default
  // view and the SessionEnd hook knows which running jobs belong to it.
  const sessionId = init.sessionId ?? process.env[SESSION_ID_ENV];
  /** @type {JobRecord} */
  const record = {
    id: init.id,
    repoPath: init.repoPath,
    prompt: init.prompt,
    model: init.model,
    status: 'running',
    startedAt: new Date().toISOString(),
    rawLogPath: rawLogPath(init.repoPath, init.id),
    ...(init.background ? { background: true } : {}),
    ...(init.cloud ? { cloud: true } : {}),
    ...(sessionId && sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
  };
  atomicWrite(jobFilePath(init.repoPath, init.id), JSON.stringify(record, null, 2));
  return record;
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @returns {JobRecord|null}
 */
export function readJob(repoPath, id) {
  const file = jobFilePath(repoPath, id);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @param {Partial<JobRecord>} patch
 * @returns {JobRecord|null}
 */
export function updateJob(repoPath, id, patch) {
  const existing = readJob(repoPath, id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  // Read-modify-write is last-writer-wins; the one race we actively guard is a
  // background worker finishing (status → done/failed) AFTER the user cancelled
  // the job. A cancellation is terminal and must not be silently overwritten.
  if (existing.status === 'cancelled' && patch.status && patch.status !== 'cancelled') {
    merged.status = 'cancelled';
  }
  atomicWrite(jobFilePath(repoPath, id), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * @typedef {Object} ListOpts
 * @property {number=} limit
 * @property {JobStatus=} status
 */

/**
 * @param {string} repoPath
 * @param {ListOpts} [opts]
 * @returns {JobRecord[]}
 */
export function listJobs(repoPath, opts = {}) {
  const dir = jobsDir(repoPath);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
  /** @type {JobRecord[]} */
  const records = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string')
        records.push(parsed);
    } catch {
      continue;
    }
  }
  records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const filtered = opts.status ? records.filter((r) => r.status === opts.status) : records;
  return typeof opts.limit === 'number' ? filtered.slice(0, opts.limit) : filtered;
}

/**
 * @param {string} repoPath
 * @param {number} [days]
 * @returns {number}
 */
export function pruneOlderThanDays(repoPath, days = 30) {
  const dir = jobsDir(repoPath);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        unlinkSync(p);
        removed += 1;
      }
    } catch {
      continue;
    }
  }
  const lDir = logsDir(repoPath);
  if (existsSync(lDir)) {
    for (const f of readdirSync(lDir)) {
      const p = join(lDir, f);
      try {
        const st = statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        continue;
      }
    }
  }
  return removed;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoPath
 * @param {string} id
 * @param {number} [graceMs]
 * @returns {Promise<JobRecord|null>}
 */
export async function cancelJob(repoPath, id, graceMs = 5_000) {
  const job = readJob(repoPath, id);
  if (!job) return null;
  if (job.status !== 'running') return job;
  // NOTE: PIDs are recycled by the OS. If the original process already exited
  // and its PID was reused, the signals below could hit an unrelated process
  // (or, for a reused group-leader pid, its process group). The job dir is
  // short-lived and pruned after 30 days, so we accept this rather than track
  // a start-time identity cross-platform.
  // Prefer the recorded cursor-agent child: a fanout worker hosts several
  // jobs in one process, so signalling the worker's group would take every
  // sibling down with it. Fall back to the worker/group when no child pid is
  // known (older records, or the agent has not been spawned yet).
  const targets = [];
  if (typeof job.childPid === 'number' && isProcessAlive(job.childPid)) targets.push(job.childPid);
  if (targets.length === 0 && typeof job.pid === 'number' && isProcessAlive(job.pid)) {
    targets.push(job.pid);
  }
  for (const pid of targets) {
    // killTree signals the worker's whole process group so the cursor-agent
    // child dies too — see lib/kill.mjs for why plain kill(pid) is not enough.
    killTree(pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isProcessAlive(pid)) {
      killTree(pid, 'SIGKILL');
    }
  }
  return updateJob(repoPath, id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Jobs a given Claude session should see by default: its own, plus records
 * with no session stamp (pre-hook jobs, or runs outside Claude Code) — those
 * cannot be attributed, so hiding them would make them undiscoverable.
 * Without a session id, everything is visible.
 *
 * @param {JobRecord[]} jobs
 * @param {string|undefined} sessionId
 * @returns {JobRecord[]}
 */
export function filterJobsForSession(jobs, sessionId) {
  if (!sessionId) return jobs;
  return jobs.filter((j) => !j.sessionId || j.sessionId === sessionId);
}

/**
 * Resolve a user-supplied id: an exact match wins, otherwise a UNIQUE prefix.
 *
 * @param {string} repoPath
 * @param {string} ref
 * @returns {{job: JobRecord|null, ambiguous?: JobRecord[]}}
 */
export function resolveJobRef(repoPath, ref) {
  const exact = readJob(repoPath, ref);
  if (exact) return { job: exact };
  const matches = listJobs(repoPath).filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0] };
  if (matches.length > 1) return { job: null, ambiguous: matches };
  return { job: null };
}

/**
 * @param {string} repoPath
 * @param {string} groupId
 * @returns {JobRecord[]}
 */
export function listGroupJobs(repoPath, groupId) {
  return listJobs(repoPath).filter((j) => j.groupId === groupId);
}

/**
 * A job whose record says `running` but whose process is gone: the worker
 * died (or the machine rebooted) before it could finalise the record.
 *
 * @param {JobRecord} job
 * @returns {boolean}
 */
export function isCrashed(job) {
  if (job.status !== 'running') return false;
  if (typeof job.pid !== 'number') return false;
  return !isProcessAlive(job.pid);
}

/**
 * @param {string} repoPath
 * @returns {JobRecord[]}
 */
export function findRunningJobs(repoPath) {
  return listJobs(repoPath).filter((j) => j.status === 'running');
}

/**
 * @param {string} repoPath
 * @returns {JobRecord|null}
 */
export function mostRecentFinishedJob(repoPath) {
  const jobs = listJobs(repoPath).filter((j) => j.status !== 'running');
  return jobs[0] ?? null;
}
