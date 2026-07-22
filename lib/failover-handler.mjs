/**
 * failover-handler.mjs
 *
 * Failover handler for the free-first cloud routing system.
 * Provides retry logic with exponential backoff + jitter, cooldown management
 * per model (via the centralized cooldown-manager), and task-state
 * checkpointing for seamless model switching.
 *
 * @module failover-handler
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  reapExpiredCooldowns,
  applyCooldown,
  clearProvider
} from './cooldown-manager.mjs';

/**
 * @typedef {Object} TaskCheckpoint
 * @property {string} taskId
 * @property {Object} originalRequest
 * @property {string[]} acceptanceCriteria
 * @property {string} currentPlan
 * @property {string[]} completedSteps
 * @property {string} worktree
 * @property {string[]} filesChanged
 * @property {string} gitDiff
 * @property {string[]} commandsExecuted
 * @property {Object} testResults
 * @property {string} failedModel
 * @property {string} failureClassification
 * @property {Object} reviewerFindings
 * @property {string} exactNextAction
 */

const RETRYABLE_SYSTEM_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'];
const RETRYABLE_MESSAGE_PATTERNS = [
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /quota/i,
  /provider\s+(outage|unavailable|error|failure)/i,
  /service\s+unavailable/i,
  /bad\s+gateway/i,
  /gateway\s+timeout/i,
  /network/i,
  /timeout/i,
  /model\s+(not\s+found|unavailable|removed|invalid|end\s+of\s+life|retired|deprecated)/i,
  /(^|\W)gone(\W|$)/i,
  /authentication|unauthorized|forbidden/i,
  /empty\s+(response|provider response|result|envelope)/i,
  /no\s+content/i,
  /interrupted/i,
  /high\s+traffic/i,
  /load\s+shed/i
];

const PROVIDER_WIDE_PATTERNS = [
  /provider.*(outage|unavailable|downtime)/i,
  /authentication.*(nvidia|provider|failed)/i,
  /all.*(models|providers).*(unavailable|failed|down)/i,
  /provider.*5\d{2}/i,
  /provider.*quota.*exhausted/i,
  /provider.*(error|failure).*all/i,
  /high\s+traffic/i,
  /load\s+shed/i,
  /rate\s+limit.*(provider|all|global)/i
];

/**
 * Resolve cooldown duration in milliseconds from a failure reason and config.
 * Mirrors the duration-selection logic that was formerly in markModelCooldown.
 *
 * @param {Object} config
 * @param {string} reason
 * @returns {number} Cooldown duration in ms
 */
function resolveCooldownDuration(config, reason) {
  const cooldowns = config?.cooldowns || {};
  const reasonLower = (reason || '').toLowerCase();

  if (reasonLower.includes('rate_limit') || reasonLower.includes('rate-limit') || reasonLower.includes('rate limit')) {
    // Single rate limit — use the single duration; repeated is handled by
    // the cooldown-manager's consecutive_failures tracking.
    return (cooldowns.single_rate_limit_minutes || 10) * 60 * 1000;
  }
  if (reasonLower.includes('quota') || reasonLower.includes('daily')) {
    return (cooldowns.daily_quota_exhausted_minutes || 720) * 60 * 1000;
  }
  if (reasonLower.includes('provider') || reasonLower.includes('provider_failure')) {
    return (cooldowns.repeated_provider_failure_minutes || cooldowns.provider_wide_failure_minutes || 10) * 60 * 1000;
  }
  return (cooldowns.default_cooldown_minutes || 15) * 60 * 1000;
}

export class FailoverHandler {
  /**
   * @param {string} configPath - Path to free-first-config.json
   * @param {string} poolsPath - Path to free-first-pools.json
   */
  constructor(configPath = './config/free-first-config.json', poolsPath = './config/free-first-pools.json') {
    this.configPath = resolve(configPath);
    this.poolsPath = resolve(poolsPath);
    /** @type {Object|null} */
    this.config = null;
    /** @type {Object|null} */
    this.pools = null;
  }

  // ---------------------------------------------------------------------------
  // Config / Pools loading
  // ---------------------------------------------------------------------------

  /** @returns {Promise<Object>} */
  async loadConfig() {
    const raw = readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);
    return this.config;
  }

  /** @returns {Promise<Object>} */
  async loadPools() {
    const raw = readFileSync(this.poolsPath, 'utf-8');
    this.pools = JSON.parse(raw);
    return this.pools;
  }

  // ---------------------------------------------------------------------------
  // Retry logic with exponential backoff + jitter
  // ---------------------------------------------------------------------------

  /**
   * Determine if an error should trigger a retry.
   *
   * @param {Error|Object} error - The error object (may have code, status, statusCode)
   * @param {number} attemptNumber - 1-based attempt number
   * @returns {Promise<boolean>} true if the operation should be retried
   */
  async shouldRetry(error, attemptNumber) {
    if (!this.config) await this.loadConfig();
    const retry = this.config.retry;

    // Check attempt count
    if (attemptNumber > retry.max_retries) {
      return false;
    }

    const errorCode = error?.code || '';
    const httpStatus = error?.status || error?.statusCode || 0;

    // Non-retryable errors (immediate fail)
    if (retry.non_retryable_errors.includes(errorCode)) {
      return false;
    }

    // Retryable HTTP codes
    if (retry.retryable_http_codes.includes(httpStatus)) {
      return true;
    }

    // Retryable system errors
    if (retry.retryable_errors.includes(errorCode)) {
      return true;
    }

    // Retryable system errors defined locally
    if (RETRYABLE_SYSTEM_ERRORS.includes(errorCode)) {
      return true;
    }

    // Default: do not retry
    return false;
  }

  classifyFailure(errorOrResult) {
    const scope = this.classifyProviderScope(errorOrResult);
    return { ...this._classifyFailure(errorOrResult), providerScope: scope };
  }

  classifyProviderScope(errorOrResult) {
    const message = String(errorOrResult?.message || errorOrResult?.stderr || errorOrResult?.stdout || errorOrResult?.error?.message || '');
    if (PROVIDER_WIDE_PATTERNS.some(p => p.test(message))) return 'provider-wide';
    return 'model-specific';
  }

  _classifyFailure(errorOrResult) {
    const error = errorOrResult?.error || errorOrResult;

    // Empty envelope / empty result detection — treat as model failure, not task
    const rawString = String(errorOrResult?.stdout || errorOrResult?.result?.stdout || '');
    if (errorOrResult?.empty === true || (errorOrResult?.result === null && !errorOrResult?.success && !errorOrResult?.taskFailure)) {
      return { retryable: true, reason: 'EMPTY_ENVELOPE', category: 'provider' };
    }
    if (errorOrResult?.taskFailure === true || error?.taskFailure === true || error?.category === 'task') {
      return { retryable: false, reason: 'TASK_FAILURE', category: 'task' };
    }

    const statusCode = error?.status || error?.statusCode || error?.httpStatus || errorOrResult?.statusCode || 0;
    const code = error?.code || errorOrResult?.code || '';
    const message = String(error?.message || errorOrResult?.message || errorOrResult?.stderr || errorOrResult?.stdout || '');
    const retryableCodes = this.config?.retry?.retryable_http_codes || [429, 500, 502, 503, 504];
    const retryableErrors = this.config?.retry?.retryable_errors || RETRYABLE_SYSTEM_ERRORS;
    const nonRetryableErrors = this.config?.retry?.non_retryable_errors || [];

    if (nonRetryableErrors.includes(code) && !/unauthorized|forbidden|auth/i.test(message)) {
      return { retryable: false, reason: code, category: 'configuration' };
    }
    if (retryableCodes.includes(statusCode)) {
      return { retryable: true, reason: `HTTP_${statusCode}`, category: 'provider' };
    }
    if (retryableErrors.includes(code)) {
      return { retryable: true, reason: code, category: 'provider' };
    }
    for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
      if (pattern.test(message)) {
        return { retryable: true, reason: pattern.source, category: 'provider' };
      }
    }
    return { retryable: false, reason: code || 'NON_RETRYABLE_FAILURE', category: 'task' };
  }

  async runWithFailover({ taskId, role, poolName, models, invoke, paidFallback, paidApproved = false, log = () => {} }) {
    if (!this.config) await this.loadConfig();
    if (!this.pools) await this.loadPools();
    if (!Array.isArray(models) || models.length === 0) {
      return { status: 'failed', code: 'NO_MODELS_AVAILABLE', attempts: [], successfulModel: null };
    }

    // Reap expired cooldowns before model selection so recently-expired models
    // become available again without waiting for the next cycle.
    const { reaped, remaining } = reapExpiredCooldowns();
    if (reaped > 0) {
      log({ type: 'cooldown-reap', taskId, reaped, remaining });
    }

    const attempts = [];
    const failures = [];
    let freeModelsAttempted = 0;
    let freeModelsExhausted = false;
    const providerCooldowns = {};  // provider → timestamp until which to skip

    for (let index = 0; index < models.length; index++) {
      const model = models[index];
      const modelId = model.modelId || model.model_id || model.id || model;
      const tier = model.tier || model.poolTier || 'freeCloud';

      // Skip if this model's provider is in cooldown (provider-wide failure)
      const provider = modelId.split('/')[0];
      if (providerCooldowns[provider] && Date.now() < providerCooldowns[provider]) {
        log({ type: 'skip-provider-cooldown', taskId, role, modelId, provider, cooldownUntil: new Date(providerCooldowns[provider]).toISOString() });
        continue;
      }
      const attempt = {
        modelId,
        tier,
        startedAt: new Date().toISOString(),
        retryable: false,
        cooldownApplied: false,
        paidFallbackConsidered: false,
        paidFallbackAuthorized: false
      };

      if (tier !== 'paidCloud') freeModelsAttempted += 1;
      if (tier === 'paidCloud') {
        attempt.paidFallbackConsidered = true;
        const allowed = paidFallback
          ? await paidFallback.isCallAllowed(taskId, role, { approved: paidApproved })
          : { allowed: false, reason: 'Paid fallback controller unavailable' };
        attempt.paidFallbackAuthorized = allowed.allowed === true;
        if (!allowed.allowed) {
          attempt.finishedAt = new Date().toISOString();
          attempt.error = allowed.reason;
          attempts.push(attempt);
          log({ type: 'paid-denied', taskId, role, modelId, reason: allowed.reason });
          return {
            status: 'failed',
            code: 'FREE_MODELS_EXHAUSTED',
            reason: allowed.reason,
            attempts,
            successfulModel: null,
            paidFallbackConsidered: true,
            paidFallbackAuthorized: false
          };
        }
        await paidFallback.logEscalation({
          taskId,
          role,
          freeModelsAttempted,
          failures,
          paidModelSelected: modelId,
          result: 'authorized'
        });
      }

      try {
        log({ type: 'attempt-start', taskId, role, modelId, tier });
        const result = await invoke({ modelId, tier, attemptIndex: index, attempts: attempts.slice() });
        attempt.finishedAt = new Date().toISOString();
        attempt.exitCode = result?.exitCode;
        attempt.sessionId = result?.sessionId || result?.sessionID || null;
        if (result?.success === true || result?.ok === true) {
          attempt.success = true;
          attempts.push(attempt);
          log({ type: 'attempt-success', taskId, role, modelId, tier });
          return {
            status: 'completed',
            result,
            attempts,
            attemptedModels: attempts.map(a => a.modelId),
            successfulModel: modelId,
            paidFallbackConsidered: attempts.some(a => a.paidFallbackConsidered),
            paidFallbackAuthorized: attempts.some(a => a.paidFallbackAuthorized)
          };
        }

        const classification = this.classifyFailure(result);
        attempt.success = false;
        attempt.retryable = classification.retryable;
        attempt.failureCategory = classification.category;
        attempt.providerScope = classification.providerScope;
        attempt.error = result?.error?.message || result?.message || result?.stderr || 'Worker failed';
        attempt.reason = classification.reason;
        attempts.push(attempt);
        failures.push({ modelId, errorCode: result?.error?.code || result?.code, statusCode: result?.statusCode, errorName: classification.reason });

        // If provider-wide failure, mark provider cooldown
        if (classification.providerScope === 'provider-wide') {
          const provider = modelId.split('/')[0];
          const cooldownMs = this.config?.cooldowns?.provider_wide_failure_minutes || 10;
          providerCooldowns[provider] = Date.now() + cooldownMs * 60 * 1000;
          log({ type: 'provider-wide-failure', taskId, role, modelId, provider, cooldownMinutes: cooldownMs });
        }
        if (!classification.retryable) {
          if (classification.category === 'task') {
            log({ type: 'attempt-task-failure', taskId, role, modelId, reason: classification.reason });
            return {
              status: 'failed',
              code: classification.reason,
              taskFailure: true,
              attempts,
              attemptedModels: attempts.map(a => a.modelId),
              successfulModel: null,
              result
            };
          }
          log({ type: 'attempt-nonretryable-fallthrough', taskId, role, modelId, reason: classification.reason, category: classification.category });
        }
      } catch (error) {
        const classification = this.classifyFailure(error);
        attempt.finishedAt = new Date().toISOString();
        attempt.success = false;
        attempt.retryable = classification.retryable;
        attempt.failureCategory = classification.category;
        attempt.error = error?.message || String(error);
        attempt.reason = classification.reason;
        attempts.push(attempt);
        failures.push({ modelId, errorCode: error?.code, statusCode: error?.status || error?.statusCode, errorName: classification.reason });
        if (!classification.retryable) {
          if (classification.category === 'task') {
            log({ type: 'attempt-task-failure', taskId, role, modelId, reason: classification.reason });
            return {
              status: 'failed',
              code: classification.reason,
              taskFailure: true,
              attempts,
              attemptedModels: attempts.map(a => a.modelId),
              successfulModel: null
            };
          }
          log({ type: 'attempt-nonretryable-fallthrough', taskId, role, modelId, reason: classification.reason, category: classification.category });
        }
      }

      try {
        // Use centralized cooldown manager for persistence
        const cooldownMs = resolveCooldownDuration(this.config, attempt.reason || 'provider_failure');
        applyCooldown(modelId, cooldownMs, attempt.reason || 'provider_failure');
        attempt.cooldownApplied = true;
      } catch {
        attempt.cooldownApplied = false;
      }
      const next = models[index + 1];
      attempt.nextModel = next ? (next.modelId || next.model_id || next.id || next) : null;
      freeModelsExhausted = attempt.nextModel === null || (next?.tier === 'paidCloud');
      log({ type: 'attempt-retryable-failure', taskId, role, modelId, nextModel: attempt.nextModel, freeModelsExhausted });
    }

    return {
      status: 'failed',
      code: freeModelsExhausted ? 'FREE_MODELS_EXHAUSTED' : 'ALL_MODELS_FAILED',
      attempts,
      attemptedModels: attempts.map(a => a.modelId),
      successfulModel: null
    };
  }

  /**
   * Compute the backoff delay with jitter.
   *
   * Formula: min(baseDelay * 2^attempt + random(0, jitterFactor * delay), maxDelay)
   *
   * @param {number} attemptNumber - 1-based attempt number
   * @returns {number} delay in milliseconds
   */
  getBackoffDelay(attemptNumber) {
    if (!this.config) {
      // Use defaults if config not loaded
      return Math.min(1000 * Math.pow(2, attemptNumber), 30000);
    }

    const retry = this.config.retry;
    const baseDelay = retry.base_delay_ms;
    const maxDelay = retry.max_delay_ms;
    const jitterFactor = retry.jitter_factor;

    // Exponential backoff
    const exponentialDelay = baseDelay * Math.pow(2, attemptNumber);

    // Clamp to max
    const clampedDelay = Math.min(exponentialDelay, maxDelay);

    // Add jitter: random 0 to jitterFactor * clampedDelay
    const jitter = jitterFactor * clampedDelay;
    const jitterValue = Math.random() * jitter;

    return Math.round(clampedDelay + jitterValue);
  }

  // ---------------------------------------------------------------------------
  // Cooldown management — delegates to centralized cooldown-manager
  // ---------------------------------------------------------------------------

  /**
   * Determine cooldown duration based on failure reason and config.
   * Mirrors the old markModelCooldown duration logic for compatibility.
   *
   * @param {Object} config
   * @param {string} reason
   * @returns {number} Duration in milliseconds
   */
  // (resolveCooldownDuration is defined at module scope below)

  /**
   * Return models from a pool that are available for the given task classification.
   *
   * @param {string} poolName - The pool name
   * @param {string} taskClassification - "normal" | "sensitive" | "local-only" | "trusted-provider-only"
   * @returns {Array<{model_id: string, role: string}>} Available models
   */
  getAvailableModels(poolName, taskClassification) {
    if (!this.pools) {
      throw new Error('Pools not loaded. Call loadPools() first.');
    }

    const pool = this.pools.pools?.[poolName];
    if (!pool) {
      throw new Error(`Pool "${poolName}" not found.`);
    }

    // Check if the pool allows this classification
    if (pool.allowed_task_classifications && !pool.allowed_task_classifications.includes(taskClassification)) {
      return [];
    }

    const now = Date.now();

    return pool.models
      .filter(model => {
        // Must be enabled
        if (!model.enabled) return false;
        // Must not be in cooldown
        if (model.cooldown_until !== null && model.cooldown_until !== undefined) {
          if (model.cooldown_until > now) return false;
        }
        return true;
      })
      .map(model => ({
        model_id: model.model_id,
        role: model.role
      }));
  }

  // ---------------------------------------------------------------------------
  // Task-state checkpointing
  // ---------------------------------------------------------------------------

  /**
   * Convenience wrapper: saves a full checkpoint with all task state fields.
   *
   * @param {TaskCheckpoint} state
   * @returns {Promise<void>}
   */
  async checkpoint(state) {
    const { taskId } = state;
    if (!taskId) throw new Error('checkpoint requires a taskId');
    await this.saveCheckpoint(taskId, state);
  }

  /**
   * Persist checkpoint data for a task.
   *
   * @param {string} taskId
   * @param {Object} data - Arbitrary serialisable state
   * @returns {Promise<void>}
   */
  async saveCheckpoint(taskId, data) {
    const filePath = `/tmp/task-checkpoint-${taskId}.json`;
    const payload = {
      savedAt: new Date().toISOString(),
      data
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /**
   * Load a previously saved checkpoint.
   *
   * @param {string} taskId
   * @returns {Promise<Object|null>} The saved data, or null if no checkpoint exists
   */
  async loadCheckpoint(taskId) {
    const filePath = `/tmp/task-checkpoint-${taskId}.json`;
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      return parsed.data ?? parsed;
    } catch {
      return null;
    }
  }

  /**
   * Remove a checkpoint for a task.
   *
   * @param {string} taskId
   * @returns {Promise<void>}
   */
  async clearCheckpoint(taskId) {
    const filePath = `/tmp/task-checkpoint-${taskId}.json`;
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
