import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import AgentLoopPlugin from '../.opencode/plugins/agent-loop.js';

const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-tool-'));
const fakeScript = resolve(dir, 'fake-opencode.cjs');
const fakeLog = resolve(dir, 'fake-opencode.jsonl');
writeFileSync(fakeScript, `const fs = require('fs');
fs.appendFileSync(process.env.AGENT_LOOP_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), child: process.env.AGENT_LOOP_CHILD, taskId: process.env.AGENT_LOOP_TASK_ID, smokeTest: process.env.AGENT_LOOP_SMOKE_TEST || '' }) + String.fromCharCode(10));
console.log(JSON.stringify({ type: 'step_start', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p1', type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p2', type: 'text', text: 'ok' } }));
console.log(JSON.stringify({ type: 'step_finish', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p3', type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } }));
console.log('RESULT: PASS');
process.exit(0);
`, 'utf8');

process.env.AGENT_LOOP_WORKER_EXECUTABLE = process.execPath;
process.env.AGENT_LOOP_WORKER_EXECUTABLE_ARGS = JSON.stringify([fakeScript]);
process.env.AGENT_LOOP_FAKE_LOG = fakeLog;
process.env.AGENT_LOOP_FORK_DISABLED = '1';
process.env.AGENT_LOOP_BUDGET_STATE_PATH = resolve(dir, 'budgets.json');
process.env.AGENT_LOOP_POLICY_STATE_PATH = resolve(dir, 'policy.json');
process.env.AGENT_LOOP_EVENT_LOG_PATH = resolve(dir, 'events.jsonl');

const plugin = await AgentLoopPlugin();
assert.ok(plugin.tool.agent_loop, 'agent_loop tool should be registered');
assert.ok(plugin.tool.orchestration_policy, 'orchestration_policy tool should be registered');
assert.ok(plugin.tool.orchestration_commit, 'orchestration_commit tool should be registered');

const context = {
  directory: dir,
  worktree: dir,
  sessionID: 'parent-session',
  messageID: 'message-1',
  agent: 'orchestrator',
  abort: new AbortController().signal,
  metadata: () => {}
};
const taskId = 'tool-integration-task';

const approvalResult = await plugin.tool.orchestration_policy.execute({
  taskId,
  action: 'record_approval',
  reason: 'The direct integration test request is approved.',
  task: 'Run a harmless build integration test.',
  riskLevel: 'medium',
  plannedPaths: ['src/example.js'],
  evidence: [{ type: 'approval', status: 'granted', ref: 'integration-test' }]
}, context);
assert.equal(JSON.parse(approvalResult.output).decision, 'allow');

const skipResult = await plugin.tool.orchestration_policy.execute({
  taskId,
  action: 'skip_baseline',
  reason: 'The fake worker integration test has no meaningful pre-change behavior.',
  riskLevel: 'medium',
  evidence: [{
    type: 'baseline_skip',
    status: 'justified',
    ref: 'fake worker harness',
    details: { justification: 'This test validates tool wiring rather than repository behavior.' }
  }]
}, context);
assert.equal(JSON.parse(skipResult.output).decision, 'allow');

const buildPolicy = await plugin.tool.orchestration_policy.execute({
  taskId,
  action: 'build',
  reason: 'Exercise the permitted worker invocation.',
  riskLevel: 'medium',
  plannedPaths: ['src/example.js']
}, context);
const buildDecision = JSON.parse(buildPolicy.output);
assert.equal(buildDecision.decision, 'allow');
assert.ok(buildDecision.permit?.id);

const missingPermit = await plugin.tool.agent_loop.execute({
  task: 'harmless smoke task',
  mode: 'build',
  taskId
}, context);
assert.equal(JSON.parse(missingPermit.output).code, 'POLICY_PERMIT_REQUIRED');

const result = await plugin.tool.agent_loop.execute({
  task: 'harmless smoke task',
  mode: 'build',
  maxRetries: 0,
  taskId,
  policyPermit: buildDecision.permit.id
}, context);
const parsed = JSON.parse(result.output);
assert.equal(parsed.status, 'completed', result.output);
assert.match(parsed.successfulModel, /.+/);
assert.equal(parsed.policy.task.taskId, taskId);
assert.ok(parsed.policy.task.evidence.some(item => item.type === 'build' && item.source === 'runtime'));

const calls = readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const buildCalls = calls.filter(call => !call.smokeTest);
assert.ok(buildCalls.length >= 1, `Expected at least 1 build call, got ${buildCalls.length}`);
const mainCall = buildCalls[buildCalls.length - 1];
assert.equal(mainCall.child, '1');
assert.ok(mainCall.args.includes('--agent'));
assert.ok(mainCall.args.includes('build-worker'));
assert.ok(mainCall.args.includes('--model'));
assert.equal(mainCall.args[mainCall.args.indexOf('--model') + 1], parsed.successfulModel);
assert.equal(parsed.budget.persistent, true);
assert.match(parsed.eventLogPath, /events\.jsonl$/);

const reused = await plugin.tool.agent_loop.execute({
  task: 'reuse permit',
  mode: 'build',
  taskId,
  policyPermit: buildDecision.permit.id
}, context);
assert.equal(JSON.parse(reused.output).code, 'POLICY_PERMIT_CONSUMED');

process.env.AGENT_LOOP_CHILD = '1';
const blockedPolicy = await plugin.tool.orchestration_policy.execute({
  taskId: 'nested-task',
  action: 'inspect',
  reason: 'nested'
}, { ...context, agent: 'build-worker' });
assert.equal(JSON.parse(blockedPolicy.output).code, 'POLICY_RECURSION_BLOCKED');

const blocked = await plugin.tool.agent_loop.execute({
  task: 'nested',
  mode: 'build',
  taskId: 'nested-task',
  policyPermit: 'not-valid'
}, { ...context, agent: 'build-worker' });
delete process.env.AGENT_LOOP_CHILD;
assert.equal(JSON.parse(blocked.output).code, 'AGENT_LOOP_RECURSION_BLOCKED');

for (const key of [
  'AGENT_LOOP_WORKER_EXECUTABLE',
  'AGENT_LOOP_WORKER_EXECUTABLE_ARGS',
  'AGENT_LOOP_FAKE_LOG',
  'AGENT_LOOP_FORK_DISABLED',
  'AGENT_LOOP_BUDGET_STATE_PATH',
  'AGENT_LOOP_POLICY_STATE_PATH',
  'AGENT_LOOP_EVENT_LOG_PATH'
]) delete process.env[key];
rmSync(dir, { recursive: true, force: true });
console.log('tool-integration-tests: passed');
