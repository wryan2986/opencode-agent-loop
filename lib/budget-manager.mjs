import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultBudgetStatePath, loadBudgetState, saveBudgetState } from './budget-store.mjs';

const stores = new Map();
const TOKEN_FIELDS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'];
const DEFAULT_LEDGER_TTL_MINUTES = 24 * 60;
const DEFAULT_MAX_TRACKED_TASKS = 1000;
const DEFAULT_MAX_WORKFLOW_CALLS = 12;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function optionalLimit(value) {
  if (value === null || value === undefined || value === false) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    estimatedCostUsd: 0,
    reportedCostUsd: 0,
    billableCostUsd: 0
  };
}

function normalizeStoredUsage(value = {}) {
  return { ...emptyUsage(), ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finiteNonNegative(item)])) };
}

export function normalizeTokenUsage(raw = {}) {
  const cache = raw.cache || {};
  const usage = {
    input: finiteNonNegative(raw.input ?? raw.inputTokens ?? raw.promptTokens),
    output: finiteNonNegative(raw.output ?? raw.outputTokens ?? raw.completionTokens),
    reasoning: finiteNonNegative(raw.reasoning ?? raw.reasoningTokens),
    cacheRead: finiteNonNegative(raw.cacheRead ?? raw.cache_read ?? cache.read),
    cacheWrite: finiteNonNegative(raw.cacheWrite ?? raw.cache_write ?? cache.write)
  };
  usage.total = TOKEN_FIELDS.reduce((sum, field) => sum + usage[field], 0);
  return usage;
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function modelMap(registry = {}) {
  return new Map((registry.models || []).map(model => [model.model_id, model]));
}

function parseLegacyPricing(notes = '') {
  const match = String(notes).match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)\s+per\s+1M\s+tokens/i);
  if (!match) return null;
  return {
    input_per_million_usd: Number(match[1]),
    output_per_million_usd: Number(match[2]),
    reasoning_per_million_usd: Number(match[2]),
    cache_read_per_million_usd: Number(match[1]),
    cache_write_per_million_usd: Number(match[1]),
    source: 'registry-notes'
  };
}

function normalizedPricing(model, fallback = {}) {
  const classification = String(model?.classification || '').toLowerCase();
  const freeType = String(model?.free_type || '').toLowerCase();
  const isLocalUnmetered = classification.startsWith('local') || freeType.startsWith('local');
  const isFree = classification.includes('free') || freeType.includes('free');
  if (isLocalUnmetered || isFree) {
    return {
      input_per_million_usd: 0,
      output_per_million_usd: 0,
      reasoning_per_million_usd: 0,
      cache_read_per_million_usd: 0,
      cache_write_per_million_usd: 0,
      source: isLocalUnmetered ? 'local-unmetered' : 'free-model'
    };
  }

  const explicit = model?.pricing;
  if (explicit && typeof explicit === 'object') {
    const input = optionalLimit(explicit.input_per_million_usd);
    const output = optionalLimit(explicit.output_per_million_usd);
    if (input !== null && output !== null) {
      return {
        input_per_million_usd: input,
        output_per_million_usd: output,
        reasoning_per_million_usd: optionalLimit(explicit.reasoning_per_million_usd) ?? output,
        cache_read_per_million_usd: optionalLimit(explicit.cache_read_per_million_usd) ?? input,
        cache_write_per_million_usd: optionalLimit(explicit.cache_write_per_million_usd) ?? input,
        source: explicit.source || 'model-registry'
      };
    }
  }

  const legacy = parseLegacyPricing(model?.notes);
  if (legacy) return legacy;

  return {
    input_per_million_usd: finiteNonNegative(fallback.input_per_million_usd),
    output_per_million_usd: finiteNonNegative(fallback.output_per_million_usd),
    reasoning_per_million_usd: finiteNonNegative(fallback.reasoning_per_million_usd ?? fallback.output_per_million_usd),
    cache_read_per_million_usd: finiteNonNegative(fallback.cache_read_per_million_usd ?? fallback.input_per_million_usd),
    cache_write_per_million_usd: finiteNonNegative(fallback.cache_write_per_million_usd ?? fallback.input_per_million_usd),
    source: 'unknown-model-fallback'
  };
}

export function estimateUsageCost({ modelId, usage, registry = {}, unknownPricing = {} } = {}) {
  const normalized = normalizeTokenUsage(usage);
  const model = modelMap(registry).get(modelId);
  const pricing = normalizedPricing(model, unknownPricing);
  const estimatedCostUsd = (
    normalized.input * pricing.input_per_million_usd +
    normalized.output * pricing.output_per_million_usd +
    normalized.reasoning * pricing.reasoning_per_million_usd +
    normalized.cacheRead * pricing.cache_read_per_million_usd +
    normalized.cacheWrite * pricing.cache_write_per_million_usd
  ) / 1_000_000;
  return { estimatedCostUsd, pricing, pricingKnown: pricing.source !== 'unknown-model-fallback', modelFound: Boolean(model) };
}

function budgetSettings(config = {}, cwd = process.cwd()) {
  const raw = config.budgets || {};
  const configuredPath = raw.state_path || '.opencode/agent-loop-state/budgets.json';
  return {
    enabled: raw.enabled !== false,
    maxTokens: optionalLimit(raw.max_tokens_per_task),
    maxInputTokens: optionalLimit(raw.max_input_tokens_per_task),
    maxOutputTokens: optionalLimit(raw.max_output_tokens_per_task),
    maxCostUsd: optionalLimit(raw.max_cost_usd_per_task),
    maxWorkflowCalls: optionalLimit(raw.max_workflow_calls_per_task) ?? DEFAULT_MAX_WORKFLOW_CALLS,
    unknownPricing: raw.unknown_paid_model_pricing || {},
    failClosedOnUnknownPricing: raw.fail_closed_on_unknown_pricing === true,
    ledgerTtlMs: positiveInteger(raw.ledger_ttl_minutes, DEFAULT_LEDGER_TTL_MINUTES) * 60 * 1000,
    maxTrackedTasks: positiveInteger(raw.max_tracked_tasks, DEFAULT_MAX_TRACKED_TASKS),
    persistenceEnabled: raw.persist_state !== false,
    statePath: process.env.AGENT_LOOP_BUDGET_STATE_PATH || resolve(cwd, configuredPath)
  };
}

function normalizeLedger(taskId, ledger = {}) {
  const normalizeGroups = groups => Object.fromEntries(Object.entries(groups || {}).map(([key, usage]) => [key, normalizeStoredUsage(usage)]));
  return {
    taskId,
    createdAtMs: Number(ledger.createdAtMs) || Date.now(),
    updatedAtMs: Number(ledger.updatedAtMs) || Date.now(),
    used: normalizeStoredUsage(ledger.used),
    steps: normalizeGroups(ledger.steps),
    models: normalizeGroups(ledger.models),
    workflowCalls: finiteNonNegative(ledger.workflowCalls),
    workflowStages: Object.fromEntries(Object.entries(ledger.workflowStages || {}).map(([key, value]) => [key, finiteNonNegative(value)])),
    exceeded: ledger.exceeded === true,
    exceededReasons: Array.isArray(ledger.exceededReasons) ? ledger.exceededReasons : [],
    unknownPricingModels: Array.isArray(ledger.unknownPricingModels) ? ledger.unknownPricingModels : []
  };
}

function getStore(settings) {
  const key = settings.persistenceEnabled ? settings.statePath : ':memory:';
  if (!stores.has(key)) {
    const loaded = settings.persistenceEnabled ? loadBudgetState(settings.statePath) : new Map();
    stores.set(key, new Map([...loaded].map(([taskId, ledger]) => [taskId, normalizeLedger(taskId, ledger)])));
  }
  return stores.get(key);
}

function persist(settings, store) {
  if (settings.persistenceEnabled) saveBudgetState(store, settings.statePath);
}

export function pruneBudgetLedgers({
  now = Date.now(),
  maxAgeMs = DEFAULT_LEDGER_TTL_MINUTES * 60 * 1000,
  maxEntries = DEFAULT_MAX_TRACKED_TASKS,
  preserveTaskId = null,
  statePath = null
} = {}) {
  const selected = statePath ? [[statePath, stores.get(statePath)]] : [...stores.entries()];
  let expired = 0;
  let overflow = 0;
  let remaining = 0;
  for (const [, store] of selected) {
    if (!store) continue;
    for (const [taskId, ledger] of store) {
      if (taskId !== preserveTaskId && now - ledger.updatedAtMs > maxAgeMs) {
        store.delete(taskId);
        expired += 1;
      }
    }
    if (store.size > maxEntries) {
      const oldest = [...store.entries()].filter(([taskId]) => taskId !== preserveTaskId).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
      while (store.size > maxEntries && oldest.length) {
        const [taskId] = oldest.shift();
        if (store.delete(taskId)) overflow += 1;
      }
    }
    remaining += store.size;
  }
  return { expired, overflow, remaining };
}

function ensureLedger(taskId, settings) {
  const store = getStore(settings);
  const now = Date.now();
  for (const [id, ledger] of store) {
    if (id !== taskId && now - ledger.updatedAtMs > settings.ledgerTtlMs) store.delete(id);
  }
  if (!store.has(taskId)) store.set(taskId, normalizeLedger(taskId));
  const ledger = store.get(taskId);
  ledger.updatedAtMs = now;
  if (store.size > settings.maxTrackedTasks) {
    const oldest = [...store.entries()].filter(([id]) => id !== taskId).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
    while (store.size > settings.maxTrackedTasks && oldest.length) store.delete(oldest.shift()[0]);
  }
  persist(settings, store);
  return { ledger, store };
}

function addUsage(target, usage, costs) {
  for (const field of TOKEN_FIELDS) target[field] += usage[field];
  target.total += usage.total;
  target.estimatedCostUsd += costs.estimatedCostUsd;
  target.reportedCostUsd += costs.reportedCostUsd;
  target.billableCostUsd += costs.billableCostUsd;
}

function remaining(limit, used) {
  return limit === null ? null : Math.max(0, limit - used);
}

export class BudgetTracker {
  constructor({ taskId, step = 'unknown', config = {}, registry = {}, cwd = process.cwd() } = {}) {
    if (!taskId) throw new Error('BudgetTracker requires taskId');
    this.taskId = taskId;
    this.step = step;
    this.settings = budgetSettings(config, cwd);
    this.registry = registry;
    const ensured = ensureLedger(taskId, this.settings);
    this.ledger = ensured.ledger;
    this.store = ensured.store;
  }

  static fromFiles({ taskId, step, configPath, registryPath, cwd = process.cwd() } = {}) {
    return new BudgetTracker({
      taskId,
      step,
      config: loadJson(configPath, {}),
      registry: loadJson(registryPath, { models: [] }),
      cwd
    });
  }

  canContinue() {
    return !this.settings.enabled || !this.ledger.exceeded;
  }

  recordWorkflowCall(stage = this.step) {
    this.ledger.workflowCalls += 1;
    this.ledger.workflowStages[stage || 'unknown'] = (this.ledger.workflowStages[stage || 'unknown'] || 0) + 1;
    this.ledger.updatedAtMs = Date.now();
    this.evaluate();
    persist(this.settings, this.store);
    return this.snapshot();
  }

  recordUsage({ modelId, usage, reportedCostUsd = 0, step = this.step } = {}) {
    const normalized = normalizeTokenUsage(usage);
    if (normalized.total === 0 && finiteNonNegative(reportedCostUsd) === 0) return this.snapshot();
    const estimate = estimateUsageCost({ modelId, usage: normalized, registry: this.registry, unknownPricing: this.settings.unknownPricing });
    const reported = finiteNonNegative(reportedCostUsd);
    const costs = { estimatedCostUsd: estimate.estimatedCostUsd, reportedCostUsd: reported, billableCostUsd: Math.max(estimate.estimatedCostUsd, reported) };
    const stepKey = step || 'unknown';
    const modelKey = modelId || 'unknown';
    this.ledger.steps[stepKey] ||= emptyUsage();
    this.ledger.models[modelKey] ||= emptyUsage();
    addUsage(this.ledger.used, normalized, costs);
    addUsage(this.ledger.steps[stepKey], normalized, costs);
    addUsage(this.ledger.models[modelKey], normalized, costs);
    this.ledger.updatedAtMs = Date.now();
    if (!estimate.pricingKnown && !this.ledger.unknownPricingModels.includes(modelKey)) this.ledger.unknownPricingModels.push(modelKey);
    this.evaluate();
    persist(this.settings, this.store);
    return this.snapshot();
  }

  evaluate() {
    if (!this.settings.enabled) return;
    const reasons = [];
    const used = this.ledger.used;
    if (this.settings.maxTokens !== null && used.total > this.settings.maxTokens) reasons.push(`total token budget exceeded (${used.total} > ${this.settings.maxTokens})`);
    if (this.settings.maxInputTokens !== null && used.input > this.settings.maxInputTokens) reasons.push(`input token budget exceeded (${used.input} > ${this.settings.maxInputTokens})`);
    if (this.settings.maxOutputTokens !== null && used.output + used.reasoning > this.settings.maxOutputTokens) reasons.push(`output token budget exceeded (${used.output + used.reasoning} > ${this.settings.maxOutputTokens})`);
    if (this.settings.maxCostUsd !== null && used.billableCostUsd > this.settings.maxCostUsd) reasons.push(`cost budget exceeded ($${used.billableCostUsd.toFixed(6)} > $${this.settings.maxCostUsd.toFixed(6)})`);
    if (this.settings.maxWorkflowCalls !== null && this.ledger.workflowCalls > this.settings.maxWorkflowCalls) reasons.push(`workflow call budget exceeded (${this.ledger.workflowCalls} > ${this.settings.maxWorkflowCalls})`);
    if (this.settings.failClosedOnUnknownPricing && this.ledger.unknownPricingModels.length) reasons.push(`pricing unavailable for: ${this.ledger.unknownPricingModels.join(', ')}`);
    if (reasons.length) {
      this.ledger.exceeded = true;
      this.ledger.exceededReasons = [...new Set([...this.ledger.exceededReasons, ...reasons])];
    }
  }

  snapshot() {
    const used = structuredClone(this.ledger.used);
    const limits = {
      maxTokens: this.settings.maxTokens,
      maxInputTokens: this.settings.maxInputTokens,
      maxOutputTokens: this.settings.maxOutputTokens,
      maxCostUsd: this.settings.maxCostUsd,
      maxWorkflowCalls: this.settings.maxWorkflowCalls
    };
    return {
      enabled: this.settings.enabled,
      scope: 'workflow-calls-and-delegated-workers',
      parentModelUsageIncluded: false,
      persistent: this.settings.persistenceEnabled,
      taskId: this.taskId,
      createdAt: new Date(this.ledger.createdAtMs).toISOString(),
      updatedAt: new Date(this.ledger.updatedAtMs).toISOString(),
      exceeded: this.ledger.exceeded,
      exceededReasons: [...this.ledger.exceededReasons],
      limits,
      used,
      workflow: { calls: this.ledger.workflowCalls, stages: structuredClone(this.ledger.workflowStages) },
      remaining: {
        tokens: remaining(limits.maxTokens, used.total),
        inputTokens: remaining(limits.maxInputTokens, used.input),
        outputTokens: remaining(limits.maxOutputTokens, used.output + used.reasoning),
        costUsd: remaining(limits.maxCostUsd, used.billableCostUsd),
        workflowCalls: remaining(limits.maxWorkflowCalls, this.ledger.workflowCalls)
      },
      steps: structuredClone(this.ledger.steps),
      models: structuredClone(this.ledger.models),
      unknownPricingModels: [...this.ledger.unknownPricingModels]
    };
  }
}

export function getBudgetLedgerCount() {
  return [...stores.values()].reduce((sum, store) => sum + store.size, 0);
}

export function resetBudgetLedger(taskId) {
  for (const [key, store] of stores) {
    if (taskId) store.delete(taskId);
    else store.clear();
    if (key !== ':memory:') saveBudgetState(store, key);
  }
}
