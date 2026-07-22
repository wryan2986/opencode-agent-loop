import { strict as assert } from 'node:assert';
import { estimateUsageCost } from '../lib/budget-manager.mjs';

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

console.log('budget-audit-tests: 1/1 passed');
