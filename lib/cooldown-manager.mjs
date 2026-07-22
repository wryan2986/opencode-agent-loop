/**
 * cooldown-manager.mjs — Centralized cooldown management for free-first pools.
 *
 * Provides:
 *   - loadState / saveState (atomic write-to-temp + rename)
 *   - reapExpiredCooldowns — clear expired cooldowns & reset failure counters
 *   - getStatus — human-readable status of all tracked models
 *   - clearProvider — clear cooldowns for a specific provider
 *   - isRetired — check model-registry for retired/permanently-disabled flag
 *
 * Uses UTC timestamps for all cooldown comparisons. Distinguishes temporary
 * cooldown (ttl-based) from permanent retirement (registry `retired` flag).
 *
 * @module cooldown-manager
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '..', 'config');
const STATE_PATH = resolve(CONFIG_DIR, 'free-first-pools-state.json');
const POOLS_PATH = resolve(CONFIG_DIR, 'free-first-pools.json');
const REGISTRY_PATH = resolve(CONFIG_DIR, 'model-registry.json');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Atomic write: write to a temp file, then rename over target.
 * This prevents partial writes from concurrent processes.
 */
function atomicWriteSync(targetPath, data) {
  const tmpDir = mkdtempSync(join(dirname(targetPath), '.tmp-'));
  const tmpPath = join(tmpDir, 'tmp');
  const encoding = typeof data === 'string' ? 'utf-8' : 'utf-8';
  try {
    writeFileSync(tmpPath, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', encoding);
    renameSync(tmpPath, targetPath);
  } finally {
    // Clean up the temp directory if rename succeeded (it'll be empty)
    try { unlinkSync(tmpPath); } catch { /* ok */ }
    try { unlinkSync(tmpDir); } catch { /* ok */ }
  }
}

function loadJson(path, fallback = null) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* fall through */ }
  return fallback;
}

function nowUTC() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// State IO
// ---------------------------------------------------------------------------

/**
 * Load runtime state from the state file.
 * Returns { models: { [modelId]: { cooldown_until, consecutive_failures } } }
 */
export function loadState() {
  return loadJson(STATE_PATH, { models: {} });
}

/**
 * Save runtime state atomically (write to temp, rename).
 * Merges into existing state to preserve unrelated entries.
 *
 * @param {Object} state  Full state object { models: {...} }
 */
export function saveState(state) {
  const current = loadState();
  // Merge: apply state's model entries, keep anything in current not overwritten
  const merged = { models: { ...current.models, ...(state.models || {}) } };
  atomicWriteSync(STATE_PATH, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Load the model registry.
 */
export function loadRegistry() {
  return loadJson(REGISTRY_PATH, { models: [] });
}

/**
 * Load pools config (merged with state).
 */
export function loadPoolsConfig() {
  return loadJson(POOLS_PATH, { pools: {} });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a model is marked as retired in the registry.
 * Retired models are permanently disabled and should never be selected.
 *
 * @param {string} modelId
 * @param {Object} [registry]  Pre-loaded registry (optional, loads fresh if omitted)
 * @returns {boolean}
 */
export function isRetired(modelId, registry) {
  if (!registry) registry = loadRegistry();
  if (!registry.models) return false;
  const entry = registry.models.find(m => m.model_id === modelId);
  if (!entry) return false;
  // retired: explicit retired flag, or enabled === false with notes indicating retirement
  if (entry.retired === true) return true;
  if (entry.enabled === false) {
    const notes = (entry.notes || '').toLowerCase();
    if (notes.includes('retired') || notes.includes('deprecated') || notes.includes('no longer available')) {
      return true;
    }
  }
  return false;
}

/**
 * Return the set of model IDs that are retired in the registry.
 */
export function listRetiredModels(registry) {
  if (!registry) registry = loadRegistry();
  if (!registry.models) return new Set();
  const retired = new Set();
  for (const entry of registry.models) {
    if (entry.retired === true || (entry.enabled === false && (
      (entry.notes || '').toLowerCase().includes('retired') ||
      (entry.notes || '').toLowerCase().includes('deprecated') ||
      (entry.notes || '').toLowerCase().includes('no longer available')
    ))) {
      retired.add(entry.model_id);
    }
  }
  return retired;
}

// ---------------------------------------------------------------------------
// Cooldown operations
// ---------------------------------------------------------------------------

/**
 * Reap (clear) expired cooldowns from the runtime state.
 *
 * For each model in state:
 *   - If cooldown_until is in the past AND the model is NOT permanently
 *     retired/disabled, clear cooldown_until and reset consecutive_failures to 0.
 *   - If cooldown_until is still in the future or the model is retired, leave it.
 *
 * Also reconciles with pools: if a model has per-model cooldown in the pools
 * JSON, those are also cleared if expired (but pools JSON is version-controlled,
 * so we only modify the runtime state file).
 *
 * @param {number} [now]  Timestamp for "now" (milliseconds since epoch). Defaults to Date.now().
 * @returns {{ reaped: number, remaining: number, retired: number }}
 *   Counts of models whose cooldown was cleared, models still in cooldown,
 *   and models retired/skipped.
 */
export function reapExpiredCooldowns(now = nowUTC()) {
  const state = loadState();
  const registry = loadRegistry();
  const retiredSet = listRetiredModels(registry);
  let reaped = 0;
  let remaining = 0;
  let retired = 0;

  for (const [modelId, modelState] of Object.entries(state.models || {})) {
    // Skip models that are permanently retired — they stay disabled regardless
    if (retiredSet.has(modelId)) {
      retired++;
      continue;
    }

    const cooldownUntil = modelState.cooldown_until;
    if (cooldownUntil !== null && cooldownUntil !== undefined && cooldownUntil !== 0) {
      const cooldownTime = typeof cooldownUntil === 'number'
        ? cooldownUntil
        : Date.parse(cooldownUntil);
      if (!Number.isNaN(cooldownTime) && cooldownTime <= now) {
        // Expired: reset
        state.models[modelId].cooldown_until = null;
        state.models[modelId].consecutive_failures = 0;
        reaped++;
      } else if (cooldownTime > now) {
        remaining++;
      }
    }
  }

  if (reaped > 0) {
    saveState(state);
  }

  return { reaped, remaining, retired };
}

/**
 * Get a human-readable status report of all models in the state.
 *
 * @param {number} [now]
 * @returns {Array<{ modelId: string, cooldownUntil: string|null, consecutiveFailures: number, status: string }>}
 */
export function getStatus(now = nowUTC()) {
  const state = loadState();
  const registry = loadRegistry();
  const retiredSet = listRetiredModels(registry);
  const results = [];

  for (const [modelId, modelState] of Object.entries(state.models || {})) {
    const cu = modelState.cooldown_until;
    let cooldownUntil = null;
    let status = 'active';

    if (retiredSet.has(modelId)) {
      status = 'retired';
    } else if (cu !== null && cu !== undefined && cu !== 0) {
      const cuTime = typeof cu === 'number' ? cu : Date.parse(cu);
      if (!Number.isNaN(cuTime)) {
        if (cuTime > now) {
          status = 'cooldown';
          cooldownUntil = new Date(cuTime).toISOString();
        } else {
          status = 'expired';
        }
      }
    }

    if (modelState.consecutive_failures > 0 && status === 'active') {
      status = `${modelState.consecutive_failures} failures`;
    }

    results.push({
      modelId,
      cooldownUntil,
      consecutiveFailures: modelState.consecutive_failures || 0,
      status
    });
  }

  return results;
}

/**
 * Clear all cooldowns for models belonging to a given provider.
 * Also resets their consecutive_failures counters.
 *
 * @param {string} providerName  e.g. "nvidia", "groq", "cerebras", "opencode"
 * @returns {number}  Number of models whose state was cleared
 */
export function clearProvider(providerName) {
  const state = loadState();
  const prefix = `${providerName}/`;
  let cleared = 0;

  for (const [modelId, modelState] of Object.entries(state.models || {})) {
    if (modelId.startsWith(prefix)) {
      state.models[modelId].cooldown_until = null;
      state.models[modelId].consecutive_failures = 0;
      cleared++;
    }
  }

  if (cleared > 0) {
    saveState(state);
  }

  return cleared;
}

/**
 * Apply a cooldown to a specific model in state.
 * Falls back to writing to pools JSON if the model is not in state.
 *
 * @param {string} modelId
 * @param {number} durationMs  Cooldown duration in milliseconds
 * @param {string} [reason]    Optional reason string
 */
export function applyCooldown(modelId, durationMs, reason) {
  const state = loadState();
  const cooldownUntil = nowUTC() + durationMs;

  state.models[modelId] = {
    ...(state.models[modelId] || {}),
    cooldown_until: cooldownUntil,
    consecutive_failures: ((state.models[modelId] || {}).consecutive_failures || 0) + 1,
  };

  saveState(state);
}

// ---------------------------------------------------------------------------
// Validation — filter retired models from a list
// ---------------------------------------------------------------------------

/**
 * Filter out retired models from a list of candidate model IDs.
 *
 * @param {string[]} modelIds
 * @param {Object} [registry]
 * @returns {string[]}
 */
export function filterRetiredModels(modelIds, registry) {
  const retired = listRetiredModels(registry);
  return modelIds.filter(id => !retired.has(id));
}
