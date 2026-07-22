/**
 * ntfy-enhancer.mjs
 *
 * Extends notification capability for the free-first cloud routing system.
 * Sends ntfy.sh notifications for paid fallback activation, free provider
 * exhaustion, credential errors, and routing failures.
 *
 * @module ntfy-enhancer
 */

/**
 * Default ntfy configuration (can be overridden via environment variables).
 */
const DEFAULTS = {
  ntfyUrl: 'https://ntfy.sh',
  topic: '',
  token: ''
};

export class NtfyEnhancer {
  constructor() {
    this.ntfyUrl = process.env.NTFY_URL || DEFAULTS.ntfyUrl;
    this.topic = process.env.NTFY_TOPIC || DEFAULTS.topic;
    this.token = process.env.NTFY_TOKEN || DEFAULTS.token;
  }

  /**
   * Internal helper to send an ntfy notification via POST.
   *
   * No secrets or credentials are included in the payload.
   *
   * @param {Object} opts
   * @param {string} opts.title - Notification title
   * @param {string} opts.message - Notification body (no secrets)
   * @param {number} [opts.priority=4] - ntfy priority (1-5)
   * @param {string} [opts.tags=''] - Comma-separated tags
   * @returns {Promise<boolean>} true if the notification was sent successfully
   * @private
   */
  async _send({ title, message, priority = 4, tags = '' }) {
    if (!this.topic) {
      // No topic configured — silently skip (acceptable for systems without ntfy)
      return false;
    }

    const url = `${this.ntfyUrl.replace(/\/+$/, '')}/${encodeURIComponent(this.topic)}`;

    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const body = JSON.stringify({
      title,
      message,
      priority,
      tags
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body
      });

      if (!response.ok) {
        // Log a warning but don't throw — notifications are non-critical
        console.warn(`[ntfy-enhancer] Notification failed (HTTP ${response.status}): ${response.statusText}`);
        return false;
      }

      return true;
    } catch (err) {
      console.warn(`[ntfy-enhancer] Notification error: ${err.code || err.message}`);
      return false;
    }
  }

  /**
   * Notify that a paid fallback model has been activated.
   *
   * Priority 5 (high urgency). Tags: moneybag,computer
   *
   * @param {Object} opts
   * @param {string} opts.taskId
   * @param {string} opts.role
   * @param {number} opts.freeAttempts - Number of free models attempted
   * @param {string} opts.paidModel - The paid model selected
   * @param {string} opts.reason - Brief reason for fallback (no secrets)
   * @returns {Promise<boolean>}
   */
  async notifyPaidFallback({ taskId, role, freeAttempts, paidModel, reason }) {
    return this._send({
      title: 'Paid model fallback activated',
      message: [
        `Task: ${taskId}`,
        `Role: ${role}`,
        `Free attempts: ${freeAttempts}`,
        `Paid model: ${paidModel}`,
        `Reason: ${reason}`
      ].join('\n'),
      priority: 5,
      tags: 'moneybag,computer'
    });
  }

  /**
   * Notify that all free providers in one or more pools have been exhausted.
   *
   * Priority 4. Tags: x,computer
   *
   * @param {Object} opts
   * @param {string} opts.taskId
   * @param {string[]} opts.poolsTried - List of pool names that were exhausted
   * @returns {Promise<boolean>}
   */
  async notifyFreeExhausted({ taskId, poolsTried }) {
    return this._send({
      title: 'All free providers exhausted',
      message: [
        `Task: ${taskId}`,
        `Pools tried: ${(poolsTried || []).join(', ')}`,
        'No free models available — attempting paid fallback or blocking.'
      ].join('\n'),
      priority: 4,
      tags: 'x,computer'
    });
  }

  /**
   * Notify that a credential or authentication error occurred with a provider.
   *
   * Priority 4. Tags: warning,computer
   *
   * The error message MUST NOT contain the actual credential value.
   *
   * @param {Object} opts
   * @param {string} opts.provider - Provider name (e.g. "openai", "groq")
   * @param {string} opts.modelId - The model_id that failed
   * @param {string} opts.error - Error description (safe — no secrets)
   * @returns {Promise<boolean>}
   */
  async notifyCredentialError({ provider, modelId, error }) {
    return this._send({
      title: 'Credential error — provider unavailable',
      message: [
        `Provider: ${provider}`,
        `Model: ${modelId}`,
        `Error: ${error}`
      ].join('\n'),
      priority: 4,
      tags: 'warning,computer'
    });
  }

  /**
   * Notify that the routing system cannot continue for a task.
   *
   * Priority 4. Tags: warning,computer
   *
   * @param {Object} opts
   * @param {string} opts.taskId
   * @param {string} opts.reason - Explanation of why routing cannot continue
   * @returns {Promise<boolean>}
   */
  async notifyCannotContinue({ taskId, reason }) {
    return this._send({
      title: 'Routing system cannot continue',
      message: [
        `Task: ${taskId}`,
        `Reason: ${reason}`
      ].join('\n'),
      priority: 4,
      tags: 'warning,computer'
    });
  }
}
