/**
 * paid-fallback.mjs
 *
 * Controls and audits paid-model fallback from free-tier providers.
 * Guards against exceeding call limits and logs all escalations
 * without leaking secrets, prompts, or credentials.
 *
 * @module paid-fallback
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {Object} EscalationLogEntry
 * @property {string} timestamp - ISO-8601
 * @property {string} taskId
 * @property {string} role
 * @property {number} freeModelsAttempted
 * @property {string} failuresSummary
 * @property {string} paidModelSelected
 * @property {string} result
 */

const ESCALATION_LOG_PATH = '/tmp/paid-escalation-log.jsonl';

export class PaidFallbackController {
  /**
   * @param {string} configPath - Path to free-first-config.json
   */
  constructor(configPath = './config/free-first-config.json') {
    this.configPath = resolve(configPath);
    /** @type {Object|null} */
    this.config = null;
    /**
     * Volatile per-task call counter (reset on restart — acceptable per spec).
     * @type {Map<string, number>}
     */
    this._callCounts = new Map();
    this._globalCallCount = 0;
  }

  /**
   * Load configuration.
   * @returns {Promise<Object>}
   */
  async _loadConfig() {
    if (this.config) return this.config;
    const raw = readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);
    return this.config;
  }

  /**
   * Check whether paid fallback is allowed for a given role.
   *
   * Verifies:
   * 1. `allow_paid_fallback` is true in config
   * 2. The role is in `paid_fallback_allowed_roles`
   *
   * @param {string} role - e.g. "orchestrator", "builder", "reviewer"
   * @returns {Promise<boolean>}
   */
  async isPaidFallbackAllowed(role) {
    const cfg = await this._loadConfig();
    const general = cfg.general;

    if (!general.allow_paid_fallback) {
      return false;
    }

    if (!general.paid_fallback_allowed_roles || !Array.isArray(general.paid_fallback_allowed_roles)) {
      return false;
    }

    return general.paid_fallback_allowed_roles.includes(role);
  }

  /**
   * Log a paid escalation event.
   *
   * The log entry MUST NOT contain prompts, secrets, or credentials.
   * Only metadata: timestamp, taskId, role, freeModelsAttempted count,
   * summary of failures, paidModelSelected, and result.
   *
   * @param {Object} opts
   * @param {string} opts.taskId
   * @param {string} opts.role
   * @param {number} opts.freeModelsAttempted - Number of free models tried
   * @param {Array<Object>} opts.failures - List of failure objects (only summary used)
   * @param {string} opts.paidModelSelected - The model_id chosen for paid fallback
   * @param {string} opts.result - Outcome description (no secrets)
   * @returns {Promise<void>}
   */
  async logEscalation({ taskId, role, freeModelsAttempted, failures, paidModelSelected, result }) {
    const cfg = await this._loadConfig();

    // Build a safe summary of failures — no prompts, secrets, or credentials
    const failuresSummary = (failures || [])
      .map((f, i) => {
        // Only include safe metadata
        const parts = [];
        if (f.modelId) parts.push(`model:${f.modelId}`);
        if (f.errorCode) parts.push(`code:${f.errorCode}`);
        if (f.errorName) parts.push(`error:${f.errorName}`);
        if (f.statusCode) parts.push(`http:${f.statusCode}`);
        // Omit 'message', 'prompt', 'response', 'credentials', 'secrets'
        return `[${i + 1}] ${parts.join(' ')}`;
      })
      .join('; ') || 'none';

    const entry = {
      timestamp: new Date().toISOString(),
      taskId,
      role,
      freeModelsAttempted,
      failuresSummary,
      paidModelSelected,
      result
    };

    // Append to JSONL file
    appendFileSync(ESCALATION_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');

    // Increment paid counters only after an authorized paid invocation is selected.
    await this.recordPaidCall(taskId);
  }

  /**
   * Get the number of paid calls made for a given task.
   *
   * @param {string} taskId
   * @returns {Promise<number>}
   */
  async getCallCount(taskId) {
    return this._callCounts.get(taskId) || 0;
  }

  /**
   * Increment the paid call counter for a task.
   *
   * @param {string} taskId
   * @returns {Promise<number>} The new count
   */
  async incrementCallCount(taskId) {
    const current = this._callCounts.get(taskId) || 0;
    const next = current + 1;
    this._callCounts.set(taskId, next);
    return next;
  }

  /**
   * Check if a paid fallback call is allowed for the given task and role,
   * enforcing the max-calls-per-task limit.
   *
   * @param {string} taskId
   * @param {string} role
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async isCallAllowed(taskId, role, options = {}) {
    const cfg = await this._loadConfig();
    const general = cfg.general;

    // 1. Must be globally allowed
    const roleAllowed = await this.isPaidFallbackAllowed(role);
    if (!roleAllowed) {
      return { allowed: false, reason: `Paid fallback not allowed for role "${role}"` };
    }

    // 2. Must not exceed max calls per task
    const maxCalls = general.paid_fallback_max_calls_per_task ?? 1;
    const currentCount = await this.getCallCount(taskId);
    if (currentCount >= maxCalls) {
      return {
        allowed: false,
        reason: `Paid fallback call limit (${maxCalls}) reached for task "${taskId}"`
      };
    }

    const globalMaxCalls = general.paid_fallback_max_calls_global;
    if (Number.isInteger(globalMaxCalls) && this._globalCallCount >= globalMaxCalls) {
      return {
        allowed: false,
        reason: `Global paid fallback call limit (${globalMaxCalls}) reached`
      };
    }

    if (general.paid_fallback_requires_approval === true && options.approved !== true) {
      return {
        allowed: false,
        reason: 'Paid fallback requires explicit approval'
      };
    }

    return { allowed: true };
  }

  async recordPaidCall(taskId) {
    this._globalCallCount += 1;
    return this.incrementCallCount(taskId);
  }
}
