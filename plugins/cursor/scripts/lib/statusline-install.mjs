// Wiring for the statusline widget into Claude Code's settings.json.
//
// Claude Code reads `statusLine: {type: 'command', command: '…'}` from
// `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). We only
// ever write that key when it is absent — a user with their own status bar
// gets a snippet to chain ours into it instead of having it replaced.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {string} */
export function settingsPath() {
  const override = process.env.CURSOR_PLUGIN_CC_CLAUDE_SETTINGS;
  if (override && override.trim()) return resolve(override);
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const base = cfg && cfg.trim() ? resolve(cfg) : join(homedir(), '.claude');
  return join(base, 'settings.json');
}

/** @returns {string} */
export function statuslineScriptPath() {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const root =
    envRoot && envRoot.trim() ? envRoot : dirname(dirname(fileURLToPath(import.meta.url)));
  return join(root, 'scripts', 'statusline.mjs');
}

/** @returns {string} */
export function statuslineCommand() {
  return `node "${statuslineScriptPath()}"`;
}

/**
 * @returns {{settings: Record<string, unknown>, existed: boolean, error?: string}}
 */
export function readSettings() {
  const file = settingsPath();
  if (!existsSync(file)) return { settings: {}, existed: false };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { settings: parsed, existed: true };
    }
    return { settings: {}, existed: true, error: `${file} does not contain a JSON object.` };
  } catch (err) {
    return {
      settings: {},
      existed: true,
      error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * @typedef {Object} InstallResult
 * @property {'installed'|'already-ours'|'conflict'|'error'} outcome
 * @property {string} file
 * @property {string} command          Our statusLine command.
 * @property {string=} existing        The command already configured, on conflict.
 * @property {string=} error
 */

/**
 * @returns {InstallResult}
 */
export function installStatusline() {
  const file = settingsPath();
  const command = statuslineCommand();
  const { settings, error } = readSettings();
  if (error) return { outcome: 'error', file, command, error };
  const current = settings.statusLine;
  if (current && typeof current === 'object') {
    const existing = /** @type {Record<string, unknown>} */ (current).command;
    if (typeof existing === 'string' && existing.includes('statusline.mjs')) {
      return { outcome: 'already-ours', file, command };
    }
    return {
      outcome: 'conflict',
      file,
      command,
      existing: typeof existing === 'string' ? existing : JSON.stringify(current),
    };
  }
  const next = { ...settings, statusLine: { type: 'command', command } };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    return {
      outcome: 'error',
      file,
      command,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { outcome: 'installed', file, command };
}
