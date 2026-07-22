import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PaidFallbackController } from '../lib/paid-fallback.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-paid-state-'));
const configPath = resolve(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({
  general: {
    allow_paid_fallback: true,
    paid_fallback_allowed_roles: ['reviewer'],
    paid_fallback_max_calls_per_task: 2,
    paid_fallback_max_calls_global: 2,
    paid_fallback_requires_approval: false,
    paid_fallback_global_window_minutes: 1,
    paid_fallback_task_state_ttl_minutes: 1,
    paid_fallback_log_path: '.opencode/agent-loop-state/paid-escalations.jsonl',
    paid_fallback_state_path: '.opencode/agent-loop-state/paid-fallback-state.json'
  }
}), 'utf8');

let now = Date.parse('2026-07-22T00:00:00Z');
const first = new PaidFallbackController(configPath, { cwd: dir, now: () => now });
assert.equal((await first.isCallAllowed('task-a', 'reviewer')).allowed, true);
await first.recordPaidCall('task-a');
await first.recordPaidCall('task-a');
assert.equal((await first.isCallAllowed('task-a', 'reviewer')).allowed, false);
assert.equal((await first.isCallAllowed('task-b', 'reviewer')).allowed, false, 'global limit should survive within the active window');

const statePath = resolve(dir, '.opencode/agent-loop-state/paid-fallback-state.json');
assert.equal(existsSync(statePath), true);

const restarted = new PaidFallbackController(configPath, { cwd: dir, now: () => now });
assert.equal(await restarted.getCallCount('task-a'), 2, 'per-task counter should survive restart');
assert.equal((await restarted.isCallAllowed('task-b', 'reviewer')).allowed, false, 'global counter should survive restart');

now += 61_000;
const nextWindow = new PaidFallbackController(configPath, { cwd: dir, now: () => now });
assert.equal(await nextWindow.getCallCount('task-a'), 0, 'expired task state should be pruned');
assert.equal((await nextWindow.isCallAllowed('task-b', 'reviewer')).allowed, true, 'global window should reset');

rmSync(dir, { recursive: true, force: true });
console.log('paid-fallback-state-tests: passed');
