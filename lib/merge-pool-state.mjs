/**
 * merge-pool-state.mjs — Merge runtime state into pools config.
 *
 * Reads config/free-first-pools.json and config/free-first-pools-state.json,
 * overlays runtime state (cooldown_until, consecutive_failures) onto each model,
 * and returns the merged result. The state file is gitignored.
 *
 * Usage:
 *   import { loadMergedPools, saveModelState } from './merge-pool-state.mjs'
 *   const pools = await loadMergedPools()
 *   await saveModelState('nvidia/mistralai/mistral-small-4-119b-2603', { cooldown_until: Date.now() + 900000 })
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, '..', 'config');
const POOLS_PATH = path.join(CONFIG_DIR, 'free-first-pools.json');
const STATE_PATH = path.join(CONFIG_DIR, 'free-first-pools-state.json');

/**
 * Load pools config with runtime state merged in.
 */
export function loadMergedPools() {
  const config = JSON.parse(readFileSync(POOLS_PATH, 'utf-8'));
  const state = loadState();

  for (const [poolName, pool] of Object.entries(config.pools)) {
    for (const model of pool.models) {
      const modelState = state.models[model.model_id];
      if (modelState) {
        model.cooldown_until = modelState.cooldown_until ?? null;
        model.consecutive_failures = modelState.consecutive_failures ?? 0;
      } else {
        model.cooldown_until = null;
        model.consecutive_failures = 0;
      }
    }
  }

  return config;
}

/**
 * Save a model's state (cooldown/cooldown_until, consecutive_failures).
 * Merges with existing state so other models are not affected.
 */
export function saveModelState(modelId, stateUpdates) {
  const state = loadState();
  state.models[modelId] = {
    ...(state.models[modelId] || {}),
    ...stateUpdates,
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Load just the state file (returns default if file doesn't exist).
 */
function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    }
  } catch {}
  return { models: {} };
}
