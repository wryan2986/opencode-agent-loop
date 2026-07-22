import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deriveProviderFromModel, providerTimeoutKey, ProviderAdapter, registerProviderAdapter, resolveProviderAdapter } from '../lib/provider-adapters.mjs';
import { AgentLoopEventLogger, redactSensitive } from '../lib/event-log.mjs';
import { loadBudgetState, saveBudgetState } from '../lib/budget-store.mjs';
import { resolveTimeoutMs } from '../runtime/opencode-worker-runner.mjs';

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

function testRecursiveRedaction() {
  const redacted = redactSensitive({
    authorization: 'Bearer secret-value',
    nested: { apiKey: 'abc123', harmless: 'ok', output: 'TOKEN=do-not-log' },
    values: ['github_pat_abcdefghijklmnopqrstuvwxyz123456']
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

for (const test of [testLocalProviderResolution, testCustomProviderAdapter, testRecursiveRedaction, testStructuredEvents, testPersistentBudgetStore]) {
  test();
  console.log(`OK: ${test.name}`);
}
console.log('reliability-v020-tests: passed');
