import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deriveProviderFromModel, providerTimeoutKey, ProviderAdapter, registerProviderAdapter, resolveProviderAdapter } from '../lib/provider-adapters.mjs';
import { AgentLoopEventLogger, redactSensitive } from '../lib/event-log.mjs';
import { loadBudgetState, saveBudgetState } from '../lib/budget-store.mjs';
import { resolveTimeoutMs } from '../runtime/opencode-worker-runner.mjs';
import { executeAgentTask } from '../runtime/execute-agent-task.mjs';

function testLocalProviderResolution() {
  assert.equal(deriveProviderFromModel('ollama-9b-local'), 'local');
  assert.equal(providerTimeoutKey('ollama-9b-local'), 'local');
  assert.equal(resolveTimeoutMs({ model: 'ollama-9b-local', providerTimeouts: { local: 420000, default: 30000 } }), 420000);
}

function testCustomProviderAdapter() {
  registerProviderAdapter(new ProviderAdapter({ id: 'acme', aliases: ['acme-cloud'], timeoutKey: 'acme-slow' }));
  assert.equal(resolveProviderAdapter('acme/model').id, 'acme');
  assert.equal(resolveProviderAdapter('anything/model', 'acme-cloud').timeoutKey, 'acme-slow');
}

function testProviderRetryPolicy() {
  const local = resolveProviderAdapter('ollama-9b-local');
  const global = {
    max_retries: 4,
    retryable_http_codes: [429, 500],
    retryable_errors: ['ETIMEDOUT'],
    non_retryable_errors: ['BUDGET_EXCEEDED']
  };
  const policy = local.retryPolicy(global, {});
  assert.equal(policy.maxRetries, 1);
  assert.equal(local.shouldRetry({ code: 'ETIMEDOUT' }, global), true);
  assert.equal(local.shouldRetry({ code: 'BUDGET_EXCEEDED' }, global), false);
  assert.equal(local.shouldRetry({ statusCode: 418 }, global), null);
}

function testRecursiveRedaction() {
  const simulatedGithubToken = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  const redacted = redactSensitive({
    authorization: 'Bearer secret-value',
    nested: { apiKey: 'abc123', harmless: 'ok', output: 'TOKEN=do-not-log' },
    values: [simulatedGithubToken]
  });
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.harmless, 'ok');
  assert.doesNotMatch(redacted.nested.output, /do-not-log/);
  assert.equal(redacted.values[0], '[REDACTED]');
}

function testStructuredEvents() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-events-'));
  const path = resolve(dir, 'events.jsonl');
  const logger = new AgentLoopEventLogger({ taskId: 'task-a', path });
  logger.emit('stage.started', { stage: 'build', data: { token: 'secret', ok: true } });
  const events = logger.query({ stage: 'build' });
  assert.equal(events.length, 1);
  assert.equal(events[0].schemaVersion, '1.0.0');
  assert.equal(events[0].data.token, '[REDACTED]');
  assert.equal(JSON.parse(readFileSync(path, 'utf8').trim()).type, 'stage.started');
  rmSync(dir, { recursive: true, force: true });
}

function testPersistentBudgetStore() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-budget-store-'));
  const path = resolve(dir, 'budgets.json');
  const ledgers = new Map([['task-a', {
    taskId: 'task-a', createdAtMs: 1, updatedAtMs: 2,
    used: { total: 25 }, steps: {}, models: {}, workflowCalls: 3,
    workflowStages: { build: 1, test: 1, review: 1 }, exceeded: false,
    exceededReasons: [], unknownPricingModels: []
  }]]);
  saveBudgetState(ledgers, path);
  const loaded = loadBudgetState(path);
  assert.equal(loaded.get('task-a').used.total, 25);
  assert.equal(loaded.get('task-a').workflowCalls, 3);
  rmSync(dir, { recursive: true, force: true });
}

async function testSameModelRetryBeforeFailover() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-retry-'));
  const configPath = resolve(dir, 'config.json');
  const poolsPath = resolve(dir, 'pools.json');
  const registryPath = resolve(dir, 'registry.json');
  writeFileSync(configPath, JSON.stringify({
    general: { allow_paid_fallback: false, paid_fallback_allowed_roles: [], paid_fallback_max_calls_per_task: 0 },
    cooldowns: { default_cooldown_minutes: 1 },
    provider_timeouts_ms: { default: 1000 },
    retry: {
      max_retries: 2, base_delay_ms: 0, max_delay_ms: 0, jitter_factor: 0,
      retryable_http_codes: [429, 500, 502, 503, 504],
      retryable_errors: ['ETIMEDOUT'],
      non_retryable_errors: ['BUDGET_EXCEEDED']
    },
    budgets: { enabled: false, persist_state: false }
  }), 'utf8');
  writeFileSync(poolsPath, JSON.stringify({ pools: { 'routine-builder': { models: [
    { model_id: 'free/first', role: 'primary', enabled: true },
    { model_id: 'free/second', role: 'free-fallback', enabled: true }
  ] } } }), 'utf8');
  writeFileSync(registryPath, JSON.stringify({ models: [
    { model_id: 'free/first', classification: 'recurring free tier' },
    { model_id: 'free/second', classification: 'recurring free tier' }
  ] }), 'utf8');

  const calls = [];
  const result = await executeAgentTask({
    taskId: 'retry-step',
    budgetTaskId: 'retry-feature',
    budgetStep: 'build',
    role: 'builder',
    agent: 'build-worker',
    prompt: 'retry test',
    cwd: dir,
    configPath,
    poolsPath,
    registryPath,
    logDir: dir,
    maxRetries: 1,
    workerAdapter: async ({ model }) => {
      calls.push(model);
      if (calls.length === 1) return { success: false, code: 'ETIMEDOUT', timedOut: true, exitCode: 1, stdout: '', stderr: 'timeout' };
      return { success: true, exitCode: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['free/first', 'free/first']);
  assert.equal(result.attemptDetails.length, 2);
  assert.equal(result.attemptDetails[1].retryIndex, 1);
  rmSync(dir, { recursive: true, force: true });
}

const tests = [
  testLocalProviderResolution,
  testCustomProviderAdapter,
  testProviderRetryPolicy,
  testRecursiveRedaction,
  testStructuredEvents,
  testPersistentBudgetStore,
  testSameModelRetryBeforeFailover
];

for (const test of tests) {
  await test();
  console.log(`OK: ${test.name}`);
}
console.log('reliability-v020-tests: passed');
