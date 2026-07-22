#!/usr/bin/env node

import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const current = fs.readFileSync(path, 'utf8');
  if (!current.includes(before)) throw new Error(`Expected text not found in ${path}`);
  fs.writeFileSync(path, current.replace(before, after));
  console.log(`Updated ${path}`);
}

replaceOnce(
  'lib/budget-manager.mjs',
  `function normalizedPricing(model, fallback = {}) {
  const classification = String(model?.classification || '').toLowerCase();
  if (classification.includes('free') || classification === 'local') {
    return {
      input_per_million_usd: 0,
      output_per_million_usd: 0,
      reasoning_per_million_usd: 0,
      cache_read_per_million_usd: 0,
      cache_write_per_million_usd: 0,
      source: 'free-model'
    };
  }
`,
  `function normalizedPricing(model, fallback = {}) {
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
`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `    function consumeJsonOutput(text, flush = false) {
      jsonLineBuffer += text;
      const lines = jsonLineBuffer.split(/\\r?\\n/);
      const tail = lines.pop() || '';
      jsonLineBuffer = flush ? '' : tail;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const event = JSON.parse(trimmed);
          const extracted = extractUsageFromEvent(event);
          if (!extracted) continue;
          usageEvents += 1;
          addUsage(usage, extracted.usage);
          reportedCostUsd += extracted.reportedCostUsd;
          if (onUsage && !budgetExceeded) {
            const decision = onUsage({
              modelId: model,
              usage: extracted.usage,
              reportedCostUsd: extracted.reportedCostUsd,
              event
            });
            if (decision?.exceeded === true || decision?.allowed === false) {
              budgetExceeded = true;
              budgetSnapshot = decision;
              if (!child.killed) child.kill('SIGTERM');
            }
          }
        } catch {
          // Ignore non-JSON output mixed into the stream.
        }
      }
      if (flush && tail.trim().startsWith('{')) {
        try {
          const event = JSON.parse(tail.trim());
          const extracted = extractUsageFromEvent(event);
          if (extracted) {
            usageEvents += 1;
            addUsage(usage, extracted.usage);
            reportedCostUsd += extracted.reportedCostUsd;
          }
        } catch {}
      }
    }
`,
  `    function recordUsageEvent(event) {
      const extracted = extractUsageFromEvent(event);
      if (!extracted) return;
      usageEvents += 1;
      addUsage(usage, extracted.usage);
      reportedCostUsd += extracted.reportedCostUsd;
      if (onUsage && !budgetExceeded) {
        const decision = onUsage({
          modelId: model,
          usage: extracted.usage,
          reportedCostUsd: extracted.reportedCostUsd,
          event
        });
        if (decision?.exceeded === true || decision?.allowed === false) {
          budgetExceeded = true;
          budgetSnapshot = decision;
          if (!child.killed) child.kill('SIGTERM');
        }
      }
    }

    function consumeJsonOutput(text, flush = false) {
      jsonLineBuffer += text;
      const lines = jsonLineBuffer.split(/\\r?\\n/);
      const tail = lines.pop() || '';
      jsonLineBuffer = flush ? '' : tail;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          recordUsageEvent(JSON.parse(trimmed));
        } catch {
          // Ignore non-JSON output mixed into the stream.
        }
      }
      if (flush && tail.trim().startsWith('{')) {
        try {
          recordUsageEvent(JSON.parse(tail.trim()));
        } catch {}
      }
    }
`
);

replaceOnce(
  'tests/budget-tests.mjs',
  `import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';`,
  `import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';`
);

replaceOnce(
  'tests/budget-tests.mjs',
  `import { extractUsageFromEvent } from '../runtime/opencode-worker-runner.mjs';`,
  `import { extractUsageFromEvent, runOpenCodeWorker } from '../runtime/opencode-worker-runner.mjs';`
);

replaceOnce(
  'tests/budget-tests.mjs',
  `    {
      model_id: 'paid/legacy',
      classification: 'paid',
      notes: '$1.00/$4.00 per 1M tokens.'
    }
`,
  `    {
      model_id: 'paid/legacy',
      classification: 'paid',
      notes: '$1.00/$4.00 per 1M tokens.'
    },
    {
      model_id: 'ollama-9b-local',
      provider: 'rx580-llama',
      classification: 'local-unmetered',
      free_type: 'local-unmetered',
      pricing: {
        input_per_million_usd: null,
        output_per_million_usd: null,
        source: 'unknown'
      }
    }
`
);

replaceOnce(
  'tests/budget-tests.mjs',
  `async function testFreeModelCostsZero() {
  const result = estimateUsageCost({
    modelId: 'free/model',
    registry,
    usage: { input: 1_000_000, output: 1_000_000 }
  });
  assert.equal(result.estimatedCostUsd, 0);
}
`,
  `async function testFreeModelCostsZero() {
  const result = estimateUsageCost({
    modelId: 'free/model',
    registry,
    usage: { input: 1_000_000, output: 1_000_000 }
  });
  assert.equal(result.estimatedCostUsd, 0);
}

async function testLocalUnmeteredModelCostsZero() {
  const result = estimateUsageCost({
    modelId: 'ollama-9b-local',
    registry,
    unknownPricing: { input_per_million_usd: 100, output_per_million_usd: 100 },
    usage: { input: 1_000_000, output: 1_000_000 }
  });
  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.pricingKnown, true);
  assert.equal(result.pricing.source, 'local-unmetered');
}

async function testFinalUnterminatedUsageEventIsReported() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-usage-tail-'));
  const executable = resolve(dir, 'fake-opencode.mjs');
  const event = {
    type: 'step_finish',
    part: {
      type: 'step-finish',
      cost: 0.001,
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }
    }
  };
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(event))});\n`, 'utf8');
  chmodSync(executable, 0o755);

  const callbacks = [];
  const result = await runOpenCodeWorker({
    cwd: dir,
    agent: 'test',
    model: 'paid/known',
    prompt: 'test',
    executable,
    timeoutMs: 5000,
    onUsage: payload => {
      callbacks.push(payload);
      return { exceeded: false };
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.usageEvents, 1);
  assert.equal(result.usage.total, 20);
  assert.equal(result.reportedCostUsd, 0.001);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].usage.total, 20);
  rmSync(dir, { recursive: true, force: true });
}
`
);

replaceOnce(
  'tests/budget-tests.mjs',
  `  testFreeModelCostsZero,
  testTracksUsageByStepAndModel,`,
  `  testFreeModelCostsZero,
  testLocalUnmeteredModelCostsZero,
  testFinalUnterminatedUsageEventIsReported,
  testTracksUsageByStepAndModel,`
);

replaceOnce(
  'CHANGELOG.md',
  `- Added configurable per-task token and cost budgets with live OpenCode usage tracking, model-registry pricing estimates, failover interruption, and structured budget output. Closes #4.

## [0.1.1]`,
  `- Added configurable per-task token and cost budgets with live OpenCode usage tracking, model-registry pricing estimates, failover interruption, and structured budget output. Closes #4.

### Fixed

- Treat local-unmetered models as zero-cost and account for a final usage event even when the JSON stream has no trailing newline.

## [0.1.1]`
);

console.log('Budget post-merge audit fixes applied.');
