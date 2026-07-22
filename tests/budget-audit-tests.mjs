import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  BudgetTracker,
  estimateUsageCost,
  getBudgetLedgerCount,
  pruneBudgetLedgers,
  resetBudgetLedger
} from '../lib/budget-manager.mjs';
import { runOpenCodeWorker } from '../runtime/opencode-worker-runner.mjs';

function testLocalUnmeteredPricing() {
  const registry = {
    models: [{
      model_id: 'ollama-9b-local',
      provider: 'rx580-llama',
      classification: 'local-unmetered',
      free_type: 'local-unmetered',
      pricing: {
        input_per_million_usd: null,
        output_per_million_usd: null,
        source: 'unknown'
      }
    }]
  };

  const result = estimateUsageCost({
    modelId: 'ollama-9b-local',
    registry,
    unknownPricing: {
      input_per_million_usd: 100,
      output_per_million_usd: 100
    },
    usage: { input: 1_000_000, output: 1_000_000 }
  });

  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.pricingKnown, true);
  assert.equal(result.pricing.source, 'local-unmetered');
}

function testLedgerRetentionIsBounded() {
  resetBudgetLedger();
  const config = {
    budgets: {
      enabled: true,
      max_tokens_per_task: 1000,
      max_input_tokens_per_task: 800,
      max_output_tokens_per_task: 200,
      max_cost_usd_per_task: 1,
      ledger_ttl_minutes: 1440,
      max_tracked_tasks: 2,
      unknown_paid_model_pricing: {}
    }
  };
  const registry = { models: [{ model_id: 'free/model', classification: 'recurring free tier' }] };

  for (const taskId of ['ledger-1', 'ledger-2', 'ledger-3']) {
    const tracker = new BudgetTracker({ taskId, step: 'build', config, registry });
    tracker.recordUsage({ modelId: 'free/model', usage: { input: 1 } });
  }

  assert.equal(getBudgetLedgerCount(), 2);
  const pruned = pruneBudgetLedgers({ now: Date.now() + 10, maxAgeMs: 0, maxEntries: 2 });
  assert.equal(pruned.remaining, 0);
  resetBudgetLedger();
}

async function testUsageAfterTerminationRemainsAccounted() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-budget-stream-'));
  const executable = resolve(dir, 'fake-worker.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
const first = { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } };
const second = { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 20, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } };
process.stdout.write(JSON.stringify(first) + '\\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify(second));
  setTimeout(() => process.exit(0), 20);
}, 20);
`, 'utf8');
  chmodSync(executable, 0o755);

  let callbackCalls = 0;
  let callbackTokens = 0;
  const result = await runOpenCodeWorker({
    cwd: dir,
    agent: 'build-worker',
    model: 'free/model',
    prompt: 'test',
    executable,
    timeoutMs: 2000,
    onUsage: ({ usage }) => {
      callbackCalls += 1;
      callbackTokens += usage.total;
      return {
        exceeded: callbackTokens >= 10,
        used: { total: callbackTokens },
        exceededReasons: ['test budget reached']
      };
    }
  });

  assert.equal(result.budgetExceeded, true);
  assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.equal(result.usageEvents, 2);
  assert.equal(result.usage.total, 30);
  assert.equal(callbackCalls, 2);
  assert.equal(callbackTokens, 30);
  assert.equal(result.budget.used.total, 30);
  rmSync(dir, { recursive: true, force: true });
}

const tests = [
  testLocalUnmeteredPricing,
  testLedgerRetentionIsBounded,
  testUsageAfterTerminationRemainsAccounted
];

let passed = 0;
for (const test of tests) {
  await test();
  passed += 1;
  console.log(`OK: ${test.name}`);
}

console.log(`budget-audit-tests: ${passed}/${tests.length} passed`);
