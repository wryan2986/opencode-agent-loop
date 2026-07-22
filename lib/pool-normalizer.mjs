import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const VALID_TIERS = new Set(['freeCloud', 'openRouterFree', 'trialCreditModels', 'paidCloud']);
const LOCAL_MODEL_IDS = new Set(['qwythos-9b-local']);

export class PoolConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolConfigError';
    this.code = 'POOL_CONFIG_INVALID';
  }
}

export function loadPoolConfig(poolsPath = './config/free-first-pools.json') {
  return JSON.parse(readFileSync(resolve(poolsPath), 'utf8'));
}

export function validateModelId(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() !== modelId || modelId.length === 0) {
    throw new PoolConfigError(`Invalid model id: ${String(modelId)}`);
  }
  if (LOCAL_MODEL_IDS.has(modelId)) return true;
  if (!/^[a-z0-9][a-z0-9._-]*\/.+$/i.test(modelId)) {
    throw new PoolConfigError(`Invalid model id "${modelId}". Expected provider/model or a known local id.`);
  }
  return true;
}

/**
 * Load the model registry JSON from the default location.
 * @returns {Object} Registry with a `models` array, or `{ models: [] }`.
 */
function loadModelRegistry() {
  const registryPath = resolve('./config/model-registry.json');
  try {
    if (existsSync(registryPath)) {
      return JSON.parse(readFileSync(registryPath, 'utf8'));
    }
  } catch { /* fall through */ }
  return { models: [] };
}

/**
 * Build a Set of model IDs that are retired/disabled in the registry.
 * A model is considered retired if:
 *   - It has `retired: true`, OR
 *   - It has `enabled: false` AND its notes indicate retirement/deprecation.
 *
 * @param {Object} [registry]  Pre-loaded registry (optional)
 * @returns {Set<string>}
 */
export function retiredModelSet(registry) {
  if (!registry) registry = loadModelRegistry();
  if (!Array.isArray(registry.models)) return new Set();
  const retired = new Set();
  for (const entry of registry.models) {
    if (entry.retired === true) {
      retired.add(entry.model_id);
    } else if (entry.enabled === false) {
      const notes = (entry.notes || '').toLowerCase();
      if (notes.includes('retired') || notes.includes('deprecated') || notes.includes('no longer available')) {
        retired.add(entry.model_id);
      }
    }
  }
  return retired;
}

function inferTier(entry) {
  if (entry.tier) {
    if (!VALID_TIERS.has(entry.tier)) {
      throw new PoolConfigError(`Invalid tier "${entry.tier}" for ${entry.id || entry.model_id}`);
    }
    return entry.tier;
  }

  const modelId = entry.id || entry.model_id;
  const role = String(entry.role || '').toLowerCase();
  const classification = String(entry.classification || '').toLowerCase();

  if (entry.trial_credit === true || entry.trialCredit === true || classification.includes('trial')) {
    return 'trialCreditModels';
  }
  if (role.includes('paid') || classification === 'paid' || modelId.startsWith('opencode-go/')) {
    return 'paidCloud';
  }
  if (role.includes('openrouter') || (modelId.startsWith('openrouter/') && modelId.includes(':free'))) {
    return 'openRouterFree';
  }
  return 'freeCloud';
}

function statusFor(entry) {
  const status = {};
  if (entry.cooldown_until !== null && entry.cooldown_until !== undefined) {
    const time = typeof entry.cooldown_until === 'number'
      ? entry.cooldown_until
      : Date.parse(entry.cooldown_until);
    if (!Number.isNaN(time) && time > Date.now()) status.cooldownUntil = time;
  }
  status.consecutiveFailures = entry.consecutive_failures || entry.consecutiveFailures || 0;
  status.role = entry.role || null;
  status.tier = inferTier(entry);
  return status;
}

export function normalizePoolConfig(config, { role, retiredModels } = {}) {
  if (!config || typeof config !== 'object') throw new PoolConfigError('Pool config must be an object');
  const pools = config.pools && typeof config.pools === 'object' ? config.pools : null;
  if (!pools) throw new PoolConfigError('Pool config must contain a pools object');

  // If no retiredModels set provided, load from registry
  if (!retiredModels || !(retiredModels instanceof Set)) {
    retiredModels = retiredModelSet();
  }

  const sourcePools = role ? { [role]: pools[role] } : pools;
  if (role && !pools[role]) throw new PoolConfigError(`Pool "${role}" not found`);

  const normalized = {
    freeCloud: [],
    openRouterFree: [],
    trialCreditModels: [],
    paidCloud: [],
    modelStatus: {}
  };

  for (const [poolName, pool] of Object.entries(sourcePools)) {
    if (!pool || !Array.isArray(pool.models)) {
      throw new PoolConfigError(`Pool "${poolName}" must contain a models array`);
    }
    const seen = new Set();
    for (const rawEntry of pool.models) {
      const entry = { ...rawEntry };
      const modelId = entry.id || entry.model_id;
      validateModelId(modelId);
      if (seen.has(modelId)) throw new PoolConfigError(`Duplicate model id "${modelId}" in pool "${poolName}"`);
      seen.add(modelId);
      if (entry.enabled === false) continue;
      // Skip models that are retired in the registry (permanently disabled)
      if (retiredModels.has(modelId)) continue;

      const tier = inferTier(entry);
      normalized[tier].push(modelId);
      normalized.modelStatus[modelId] = statusFor(entry);
    }
  }

  return normalized;
}

export function getPoolModels(config, role) {
  const normalized = normalizePoolConfig(config, { role });
  return [
    ...normalized.freeCloud,
    ...normalized.openRouterFree,
    ...normalized.trialCreditModels,
    ...normalized.paidCloud
  ];
}

export function isModelCoolingDown(normalized, modelId, now = Date.now()) {
  const cooldownUntil = normalized?.modelStatus?.[modelId]?.cooldownUntil;
  return typeof cooldownUntil === 'number' && cooldownUntil > now;
}
