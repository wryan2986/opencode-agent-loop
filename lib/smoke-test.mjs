import { runOpenCodeWorker, deriveProviderFromModel, resolveTimeoutMs } from '../runtime/opencode-worker-runner.mjs';
import { isRetired, loadRegistry } from './cooldown-manager.mjs';

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function updateProgress(pc, title, metadata) {
  if (!pc) return;
  try {
    pc({ title, metadata: { ...metadata, _t: Date.now() } });
    await yieldToEventLoop();
  } catch {}
}

/**
 * Run smoke tests against an array of model entries.
 * Retired/disabled models are silently skipped before any API call.
 *
 * @param {Object} options
 * @param {Array<{modelId:string,tier?:string}>} options.models
 * @param {Object} [options.providerTimeouts]
 * @param {string} [options.smokeTestPrompt]
 * @param {number} [options.smokeTestTimeoutMs]
 * @param {Object} [options.smokeTestProviderTimeouts]
 * @param {string} [options.cwd]
 * @param {string} [options.agent]
 * @param {Object} [options.env]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.progressCallback]
 * @returns {Promise<{responsive:Array, unresponsive:Array, skipped:Array}>}
 */
export async function runSmokeTest({
  models,
  providerTimeouts = {},
  smokeTestPrompt = 'Reply with exactly one word: ok',
  smokeTestTimeoutMs = 30000,
  smokeTestProviderTimeouts = {},
  cwd = '/tmp',
  agent = 'build-worker',
  env = {},
  signal,
  progressCallback,
  onUsage
}) {
  if (!Array.isArray(models) || models.length === 0) {
    return { responsive: [], unresponsive: [], skipped: [] };
  }

  const results = { responsive: [], unresponsive: [], skipped: [], budgetExceeded: false, budget: null };
  const registry = loadRegistry();

  for (const entry of models) {
    const modelId = entry.modelId || entry.model_id || entry.id || entry;

    // Skip retired / permanently-disabled models — no point smoke-testing them
    if (isRetired(modelId, registry)) {
      results.skipped.push({ modelId, reason: 'retired' });
      continue;
    }

    const provider = deriveProviderFromModel(modelId);
    const timeoutMs = smokeTestProviderTimeouts[provider] || smokeTestProviderTimeouts.default || smokeTestTimeoutMs;

    await updateProgress(progressCallback, `Smoke testing ${modelId.split('/').pop()}...`, { model: modelId, action: 'smoke-test', provider });
    const startedAt = Date.now();
    try {
      const invocation = await runOpenCodeWorker({
        cwd,
        agent,
        model: modelId,
        prompt: smokeTestPrompt,
        timeoutMs,
        env: {
          ...env,
          AGENT_LOOP_SMOKE_TEST: '1'
        },
        signal,
        title: `smoke-test-${modelId.replace(/[^a-z0-9]/gi, '-')}`,
        onUsage
      });

      const elapsed = Date.now() - startedAt;
      if (invocation.budgetExceeded) {
        results.budgetExceeded = true;
        results.budget = invocation.budget || null;
        results.unresponsive.push({ modelId, provider, elapsed, timedOut: false, error: 'BUDGET_EXCEEDED' });
        await updateProgress(progressCallback, 'Task budget exceeded during smoke test', { model: modelId, action: 'budget-exceeded', status: 'blocked', budget: results.budget });
        break;
      }
      if (invocation.success === true) {
        results.responsive.push({ modelId, provider, elapsed, timedOut: false, error: null });
        await updateProgress(progressCallback, `${modelId.split('/').pop()}: responsive (${elapsed}ms)`, { model: modelId, action: 'smoke-result', status: 'responsive', elapsed });
      } else if (invocation.timedOut) {
        results.unresponsive.push({ modelId, provider, elapsed, timedOut: true, error: 'TIMEOUT' });
        await updateProgress(progressCallback, `${modelId.split('/').pop()}: timeout (${elapsed}ms)`, { model: modelId, action: 'smoke-result', status: 'timeout', elapsed });
      } else {
        const statusCode = invocation.statusCode || invocation.error?.statusCode;
        const errCode = invocation.code || `HTTP_${statusCode || 'FAIL'}`;
        results.unresponsive.push({ modelId, provider, elapsed, timedOut: false, error: errCode });
        await updateProgress(progressCallback, `${modelId.split('/').pop()}: ${errCode}`, { model: modelId, action: 'smoke-result', status: 'error', code: errCode, elapsed });
      }
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      results.unresponsive.push({ modelId, provider, elapsed, timedOut: false, error: err.code || err.message });
      await updateProgress(progressCallback, `${modelId.split('/').pop()}: error`, { model: modelId, action: 'smoke-result', status: 'error', error: err.code || err.message, elapsed });
    }
  }

  return results;
}

/**
 * Filter a list of model entries to only those that were responsive.
 * Returns the original list unmodified if smokeResults is null/empty.
 */
export function filterResponsiveModels(models, smokeResults) {
  if (!smokeResults || !Array.isArray(smokeResults.responsive) || smokeResults.responsive.length === 0) {
    return models;
  }
  const responsiveIds = new Set(smokeResults.responsive.map(r => r.modelId));
  return models.filter(m => {
    const id = m.modelId || m.model_id || m.id || m;
    return responsiveIds.has(id);
  });
}
