import { readFileSync } from 'node:fs';

const ledgers = new Map();

const TOKEN_FIELDS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'];

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function optionalLimit(value) {
  if (value === null || value === undefined || value === false) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
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
  const perMillion = 1_000_000;
  const estimatedCostUsd = (
    normalized.input * pricing.input_per_million_usd +
    normalized.output * pricing.output_per_million_usd +
    normalized.reasoning * pricing.reasoning_per_million_usd +
    normalized.cacheRead * pricing.cache_read_per_million_usd +
    normalized.cacheWrite * pricing.cache_write_per_million_usd
  ) / perMillion;

  return {
    estimatedCostUsd,
    pricing,
    pricingKnown: pricing.source !== 'unknown-model-fallback',
    modelFound: Boolean(model)
  };
}

function budgetSettings(config = {}) {
  const raw = config.budgets || {};
  return {
    enabled: raw.enabled !== false,
    maxTokens: optionalLimit(raw.max_tokens_per_task),
    maxInputTokens: optionalLimit(raw.max_input_tokens_per_task),
    maxOutputTokens: optionalLimit(raw.max_output_tokens_per_task),
    maxCostUsd: optionalLimit(raw.max_cost_usd_per_task),
    unknownPricing: raw.unknown_paid_model_pricing || {},
    failClosedOnUnknownPricing: raw.fail_closed_on_unknown_pricing === true
  };
}

function ensureLedger(taskId) {
  if (!ledgers.has(taskId)) {
    ledgers.set(taskId, {
      taskId,
      used: emptyUsage(),
      steps: {},
      models: {},
      exceeded: false,
      exceededReasons: [],
      unknownPricingModels: []
    });
  }
  return ledgers.get(taskId);
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
  constructor({ taskId, step = 'unknown', config = {}, registry = {} } = {}) {
    if (!taskId) throw new Error('BudgetTracker requires taskId');
    this.taskId = taskId;
    this.step = step;
    this.settings = budgetSettings(config);
    this.registry = registry;
    this.ledger = ensureLedger(taskId);
  }

  static fromFiles({ taskId, step, configPath, registryPath } = {}) {
    const config = loadJson(configPath, {});
    const registry = loadJson(registryPath, { models: [] });
    return new BudgetTracker({ taskId, step, config, registry });
  }

  canContinue() {
    return !this.settings.enabled || !this.ledger.exceeded;
  }

  recordUsage({ modelId, usage, reportedCostUsd = 0, step = this.step } = {}) {
    const normalized = normalizeTokenUsage(usage);
    if (normalized.total === 0 && finiteNonNegative(reportedCostUsd) === 0) return this.snapshot();

    const estimate = estimateUsageCost({
      modelId,
      usage: normalized,
      registry: this.registry,
      unknownPricing: this.settings.unknownPricing
    });
    const reported = finiteNonNegative(reportedCostUsd);
    const billable = Math.max(estimate.estimatedCostUsd, reported);
    const costs = {
      estimatedCostUsd: estimate.estimatedCostUsd,
      reportedCostUsd: reported,
      billableCostUsd: billable
    };

    const stepKey = step || 'unknown';
    const modelKey = modelId || 'unknown';
    this.ledger.steps[stepKey] ||= emptyUsage();
    this.ledger.models[modelKey] ||= emptyUsage();
    addUsage(this.ledger.used, normalized, costs);
    addUsage(this.ledger.steps[stepKey], normalized, costs);
    addUsage(this.ledger.models[modelKey], normalized, costs);

    if (!estimate.pricingKnown && !this.ledger.unknownPricingModels.includes(modelKey)) {
      this.ledger.unknownPricingModels.push(modelKey);
    }

    this.evaluate();
    return this.snapshot();
  }

  evaluate() {
    if (!this.settings.enabled) return;
    const reasons = [];
    const used = this.ledger.used;
    if (this.settings.maxTokens !== null && used.total > this.settings.maxTokens) {
      reasons.push(`total token budget exceeded (${used.total} > ${this.settings.maxTokens})`);
    }
    if (this.settings.maxInputTokens !== null && used.input > this.settings.maxInputTokens) {
      reasons.push(`input token budget exceeded (${used.input} > ${this.settings.maxInputTokens})`);
    }
    if (this.settings.maxOutputTokens !== null && used.output + used.reasoning > this.settings.maxOutputTokens) {
      reasons.push(`output token budget exceeded (${used.output + used.reasoning} > ${this.settings.maxOutputTokens})`);
    }
    if (this.settings.maxCostUsd !== null && used.billableCostUsd > this.settings.maxCostUsd) {
      reasons.push(`cost budget exceeded ($${used.billableCostUsd.toFixed(6)} > $${this.settings.maxCostUsd.toFixed(6)})`);
    }
    if (this.settings.failClosedOnUnknownPricing && this.ledger.unknownPricingModels.length > 0) {
      reasons.push(`pricing unavailable for: ${this.ledger.unknownPricingModels.join(', ')}`);
    }
    if (reasons.length > 0) {
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
      maxCostUsd: this.settings.maxCostUsd
    };
    return {
      enabled: this.settings.enabled,
      taskId: this.taskId,
      exceeded: this.ledger.exceeded,
      exceededReasons: [...this.ledger.exceededReasons],
      limits,
      used,
      remaining: {
        tokens: remaining(limits.maxTokens, used.total),
        inputTokens: remaining(limits.maxInputTokens, used.input),
        outputTokens: remaining(limits.maxOutputTokens, used.output + used.reasoning),
        costUsd: remaining(limits.maxCostUsd, used.billableCostUsd)
      },
      steps: structuredClone(this.ledger.steps),
      models: structuredClone(this.ledger.models),
      unknownPricingModels: [...this.ledger.unknownPricingModels]
    };
  }
}

export function resetBudgetLedger(taskId) {
  if (taskId) ledgers.delete(taskId);
  else ledgers.clear();
}
