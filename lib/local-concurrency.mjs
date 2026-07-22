/**
 * local-concurrency.mjs
 *
 * Local model concurrency lease enforcement.
 * Ensures only one active request to the Ollama local model at a time.
 * Additional requests queue or trigger fallback to the next eligible free provider.
 *
 * @module local-concurrency
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

const LOCK_FILE = '/tmp/ollama-concurrency.lock';
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes stale timeout

/**
 * Acquire the local model lease.
 * @returns {{ acquired: boolean, reason?: string }}
 */
export function acquireLocalLease({ taskId = 'unknown', timeoutMs = 420000 } = {}) {
  const now = Date.now();

  // Check if lock exists and is not stale
  if (existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const age = now - (lockData.acquiredAt || 0);

      if (age < LOCK_STALE_MS) {
        // Lock is still active
        return {
          acquired: false,
          reason: `Local model concurrency limit reached. Task "${lockData.taskId}" holds the lease (age: ${Math.round(age / 1000)}s).`
        };
      }

      // Stale lock - release it
      console.warn(`[local-concurrency] Stale lock detected (age: ${Math.round(age / 1000)}s). Releasing.`);
    } catch {
      // Corrupt lock file - remove and proceed
      console.warn('[local-concurrency] Corrupt lock file. Removing.');
    }
  }

  // Acquire the lock
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({
      taskId,
      acquiredAt: now,
      expiresAt: now + timeoutMs,
      hostname: require?.('os')?.hostname?.() || 'unknown'
    }, null, 2), 'utf8');
    return { acquired: true };
  } catch (err) {
    return { acquired: false, reason: `Failed to write lock file: ${err.message}` };
  }
}

/**
 * Release the local model lease.
 */
export function releaseLocalLease() {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the local model lease is currently held.
 * @returns {boolean}
 */
export function isLocalLeaseHeld() {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    const age = Date.now() - (lockData.acquiredAt || 0);
    return age < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Get the current lease info, or null if not held.
 * @returns {Object|null}
 */
export function getLocalLeaseInfo() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Wrap a task function with the concurrency lease.
 * If lease cannot be acquired, the task is not executed and the fallback is called.
 *
 * @param {Function} taskFn - Async function to execute under the lease
 * @param {Function} fallbackFn - Called if lease cannot be acquired
 * @param {Object} options
 * @param {string} options.taskId
 * @param {number} options.timeoutMs
 * @returns {Promise<*>}
 */
export async function withLocalLease(taskFn, fallbackFn, { taskId = 'unknown', timeoutMs = 420000 } = {}) {
  const lease = acquireLocalLease({ taskId, timeoutMs });

  if (!lease.acquired) {
    return typeof fallbackFn === 'function' ? await fallbackFn(lease.reason) : { success: false, reason: lease.reason };
  }

  try {
    const result = await taskFn();
    return result;
  } finally {
    releaseLocalLease();
  }
}
