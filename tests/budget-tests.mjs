import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  BudgetTracker,
  estimateUsageCost,
  normalizeTokenUsage,
  resetBudgetLedger
} from '../lib/budget-manager.mjs';
import { extractUsageFromEvent } from '../runtime/opencode-worker-runner.mjs';
import { executeAgentTask } from '../runtime/execute-agent-task.mjs';

const registry = {
  models: [
    {
      model_id: 'free/model',
      classification: 'recurring free tier'
    },
    {
      model_id: 'paid/known',
      classification: 'paid',
      pricing: {
        input_per_million_usd: 2,
        output_per_million_usd: 8,
        reasoning_per_million_usd: 8,
        cache_read_per_million_usd: 0.5,
        cache_write_per_million_usd: 2,
        source: 'test'
      }
    },
    {
      model_id: 'paid/legacy',
      classification: 'paid',
      notes: '$1.00/$4.00 per 1M tokens.'
    }
  ]
};

function config(overrides = {}) {
  return {
    budgets: {
      enabled: true,
      max_tokens_per_task: 1000,
      max_input_tokens_per_task: 800,
      max_output_tokens_per_task: 300,
      max_cost_usd_per_task: 0.01,
      unknown_paid_model_pricing: {
        input_per_million_usd: 5,
        output_per_million_usd: 15,
        reasoning_per_million_usd: 15,
        cache_read_per_million_usd: 1,
        cache_write_per_million_usd: 5
      },
      ...overrides
    }
  };
}

async function testNormalizesOpenCodeUsageShape() {
  const usage = normalizeTokenUsage({
    input: 10,
    output: 20,
    reasoning: 5,
    cache: { read: 30, write: 2 }
  });
  assert.deepEqual(usage, {
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 30,
    cacheWrite: 2,
    total: 67
  });
}

async function testExtractsOpenCodeStepFinishEvent() {
  const extracted = extractUsageFromEvent({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      cost: 0.0123,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 2 } }
    }
  });
  assert.equal(extracted.reportedCostUsd, 0.0123);
  assert.equal(extracted.usage.total, 177);
}

async function testEstimatesStructuredRegistryPricing() {
  const result = estimateUsageCost({
    modelId: 'paid/known',
    registry,
    usage: { input: 1_000_000, output: 500_000, reasoning: 250_000, cache: { read: 100_000, write: 50_000 } }
  });
  assert.equal(result.pricingKnown, true);
  assert.equal(result.pricing.source, 'test');
  assert.equal(result.estimatedCostUsd, 8.15);
}

async function testParsesLegacyRegistryNotes() {
  const result = estimateUsageCost({
    modelId: 'paid/legacy',
    registry,
    usage: { input: 1_000_000, output: 1_000_000 }
  });
  assert.equal(result.pricingKnown, true);
  assert.equal(result.pricing.source, 'registry-notes');
  assert.equal(result.estimatedCostUsd, 5);
}

async function testFreeModelCostsZero() {
  const result = estimateUsageCost({
    modelId: 'free/model',
    registry,
    usage: { input: 1_000_000, output: 1_000_000 }
  });
  assert.equal(result.estimatedCostUsd, 0);
}

async function testTracksUsageByStepAndModel() {
  resetBudgetLedger('tracking');
  const tracker = new BudgetTracker({ taskId: 'tracking', step: 'build', config: config(), registry });
  tracker.recordUsage({ modelId: 'paid/known', usage: { input: 100, output: 25 } });
  tracker.recordUsage({ modelId: 'paid/known', step: 'review', usage: { input: 50, output: 10 } });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.used.total, 185);
  assert.equal(snapshot.steps.build.total, 125);
  assert.equal(snapshot.steps.review.total, 60);
  assert.equal(snapshot.models['paid/known'].total, 185);
  assert.equal(snapshot.exceeded, false);
}

async function testStopsAfterTokenBudgetExceeded() {
  resetBudgetLedger('tokens');
  const tracker = new BudgetTracker({ taskId: 'tokens', step: 'build', config: config(), registry });
  const snapshot = tracker.recordUsage({ modelId: 'free/model', usage: { input: 850, output: 200 } });
  assert.equal(snapshot.exceeded, true);
  assert.equal(tracker.canContinue(), false);
  assert.ok(snapshot.exceededReasons.some(reason => reason.includes('total token budget exceeded')));
  assert.ok(snapshot.exceededReasons.some(reason => reason.includes('input token budget exceeded')));
}

async function testStopsAfterCostBudgetExceeded() {
  resetBudgetLedger('cost');
  const tracker = new BudgetTracker({ taskId: 'cost', step: 'build', config: config({ max_cost_usd_per_task: 0.001 }), registry });
  const snapshot = tracker.recordUsage({ modelId: 'paid/known', usage: { input: 500, output: 100 } });
  assert.equal(snapshot.exceeded, true);
  assert.ok(snapshot.used.billableCostUsd > 0.001);
  assert.ok(snapshot.exceededReasons.some(reason => reason.includes('cost budget exceeded')));
}

async function testUsesConservativeUnknownPriceFallback() {
  resetBudgetLedger('unknown');
  const tracker = new BudgetTracker({ taskId: 'unknown', step: 'build', config: config(), registry });
  const snapshot = tracker.recordUsage({ modelId: 'paid/unknown', usage: { input: 1000, output: 100 } });
  assert.deepEqual(snapshot.unknownPricingModels, ['paid/unknown']);
  assert.equal(snapshot.used.estimatedCostUsd, 0.0065);
}

async function testSharedLedgerAcrossSteps() {
  resetBudgetLedger('shared');
  const build = new BudgetTracker({ taskId: 'shared', step: 'build', config: config(), registry });
  const review = new BudgetTracker({ taskId: 'shared', step: 'review', config: config(), registry });
  build.recordUsage({ modelId: 'free/model', usage: { input: 500, output: 50 } });
  const snapshot = review.recordUsage({ modelId: 'free/model', usage: { input: 350, output: 150 } });
  assert.equal(snapshot.used.total, 1050);
  assert.equal(snapshot.exceeded, true);
  assert.equal(build.canContinue(), false);
}

async function testReportedCostCannotLowerEstimate() {
  resetBudgetLedger('reported');
  const tracker = new BudgetTracker({ taskId: 'reported', step: 'build', config: config(), registry });
  const snapshot = tracker.recordUsage({
    modelId: 'paid/known',
    usage: { input: 1000, output: 100 },
    reportedCostUsd: 0.0001
  });
  assert.equal(snapshot.used.billableCostUsd, snapshot.used.estimatedCostUsd);
}

async function testBudgetExceededStopsFailover() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-budget-'));
  const configPath = resolve(dir, 'free-first-config.json');
  const poolsPath = resolve(dir, 'free-first-pools.json');
  const registryPath = resolve(dir, 'model-registry.json');
  writeFileSync(configPath, JSON.stringify({
    budgets: {
      enabled: true,
      max_tokens_per_task: 100,
      max_input_tokens_per_task: 100,
      max_output_tokens_per_task: 100,
      max_cost_usd_per_task: 1,
      unknown_paid_model_pricing: {}
    },
    general: {
      allow_paid_fallback: false,
      paid_fallback_allowed_roles: [],
      paid_fallback_max_calls_per_task: 0
    },
    cooldowns: { default_cooldown_minutes: 1 },
    retry: {
      max_retries: 0,
      retryable_http_codes: [429, 500, 502, 503, 504],
      retryable_errors: ['ETIMEDOUT'],
      non_retryable_errors: ['BUDGET_EXCEEDED']
    }
  }), 'utf8');
  writeFileSync(poolsPath, JSON.stringify({ pools: { 'routine-builder': { models: [
    { model_id: 'free/model', role: 'primary', enabled: true },
    { model_id: 'free/second', role: 'free-fallback', enabled: true }
  ] } } }), 'utf8');
  writeFileSync(registryPath, JSON.stringify({ models: [
    { model_id: 'free/model', classification: 'recurring free tier' },
    { model_id: 'free/second', classification: 'recurring free tier' }
  ] }), 'utf8');

  const calls = [];
  const result = await executeAgentTask({
    taskId: 'budget-integration-build',
    budgetTaskId: 'budget-integration',
    budgetStep: 'build',
    role: 'builder',
    agent: 'build-worker',
    prompt: 'do work',
    cwd: dir,
    configPath,
    poolsPath,
    registryPath,
    logDir: dir,
    workerAdapter: async ({ model, onUsage }) => {
      calls.push(model);
      const budget = onUsage({
        modelId: model,
        usage: { input: 120, output: 10 },
        reportedCostUsd: 0
      });
      return {
        success: false,
        code: 'BUDGET_EXCEEDED',
        budgetExceeded: true,
        budget,
        usage: { input: 120, output: 10 },
        usageReportedIncrementally: true,
        exitCode: 143
      };
    }
  });

  assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.equal(result.budget.exceeded, true);
  assert.deepEqual(calls, ['free/model']);
  assert.equal(result.attemptDetails[0].budgetExceeded, true);
  rmSync(dir, { recursive: true, force: true });
  resetBudgetLedger('budget-integration');
}

const tests = [
  testNormalizesOpenCodeUsageShape,
  testExtractsOpenCodeStepFinishEvent,
  testEstimatesStructuredRegistryPricing,
  testParsesLegacyRegistryNotes,
  testFreeModelCostsZero,
  testTracksUsageByStepAndModel,
  testStopsAfterTokenBudgetExceeded,
  testStopsAfterCostBudgetExceeded,
  testUsesConservativeUnknownPriceFallback,
  testSharedLedgerAcrossSteps,
  testReportedCostCannotLowerEstimate,
  testBudgetExceededStopsFailover
];

let passed = 0;
for (const test of tests) {
  await test();
  passed += 1;
  console.log(`OK: ${test.name}`);
}
console.log(`budget-tests: ${passed}/${tests.length} passed`);
