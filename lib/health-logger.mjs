/**
 * health-logger.mjs — Append-only subagent health telemetry.
 *
 * Records each subagent call to ~/.opencode/agent-health.jsonl for trend analysis.
 * One JSON object per line — easy to grep, tail, or process with jq.
 *
 * Usage:
 *   import { logSubagentCall } from './health-logger.mjs'
 *   await logSubagentCall({ subagentType: 'test', model: 'cerebras/gpt-oss-120b', status: 'success', durationMs: 12345 })
 *
 * View recent failures:
 *   tail -100 ~/.opencode/agent-health.jsonl | grep '"status":"failed"' | jq .
 *
 * Summary by provider:
 *   jq -r '{provider: (.model | split("/")[0]), status, subagentType}' ~/.opencode/agent-health.jsonl | sort | uniq -c | sort -rn
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.resolve(os.homedir(), '.opencode');
const LOG_PATH = path.join(LOG_DIR, 'agent-health.jsonl');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const VALID_STATUSES = ['success', 'failed', 'timeout', 'config_error'];

/**
 * Log a subagent call result to the health telemetry log.
 *
 * @param {Object} entry
 * @param {string} entry.subagentType - e.g. 'test', 'review', 'trivial-builder'
 * @param {string} entry.model - Full model ID e.g. 'cerebras/gpt-oss-120b'
 * @param {'success'|'failed'|'timeout'|'config_error'} entry.status - Outcome
 * @param {number} entry.durationMs - Wall-clock time in milliseconds
 * @param {string} [entry.error] - Brief error message or code (omit on success)
 * @param {string} [entry.taskId] - Optional task/session ID for traceability
 */
export function logSubagentCall({ subagentType, model, status, durationMs, error, taskId }) {
  if (!subagentType || !model || !status) {
    console.warn('[health-logger] Missing required fields:', { subagentType, model, status });
    return;
  }

  if (!VALID_STATUSES.includes(status)) {
    console.warn('[health-logger] Invalid status:', status, '(expected one of:', VALID_STATUSES.join(', '), ')');
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    subagentType,
    model,
    provider: model.split('/')[0] || model,
    status,
    durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : null,
    error: error || null,
    taskId: taskId || null,
  };

  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[health-logger] Failed to write:', err.message);
  }
}

/**
 * Get a quick summary of recent failures.
 * @param {number} [minutes=60] - How far back to look
 * @returns {Object} Summary counts
 */
export function getRecentSummary(minutes = 60) {
  const since = Date.now() - minutes * 60 * 1000;
  const results = { total: 0, byStatus: {}, byProvider: {}, bySubagent: {} };

  try {
    const lines = require('fs').readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime < since) continue;

        results.total++;
        results.byStatus[entry.status] = (results.byStatus[entry.status] || 0) + 1;
        results.byProvider[entry.provider] = (results.byProvider[entry.provider] || 0) + 1;
        const key = `${entry.subagentType}/${entry.status}`;
        results.bySubagent[key] = (results.bySubagent[key] || 0) + 1;
      } catch {}
    }
  } catch {}

  return results;
}
