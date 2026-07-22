import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import AgentLoopPlugin from '../.opencode/plugins/agent-loop.js';

const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-tool-'));
const fakeScript = resolve(dir, 'fake-opencode.cjs');
const fakeLog = resolve(dir, 'fake-opencode.jsonl');
writeFileSync(fakeScript, `const fs = require('fs');
fs.appendFileSync(process.env.AGENT_LOOP_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), child: process.env.AGENT_LOOP_CHILD, taskId: process.env.AGENT_LOOP_TASK_ID, smokeTest: process.env.AGENT_LOOP_SMOKE_TEST || '' }) + '\\n');
console.log(JSON.stringify({ type: 'step_start', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p1', type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p2', type: 'text', text: 'ok' } }));
console.log(JSON.stringify({ type: 'step_finish', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p3', type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } }));
console.log('RESULT: PASS');
process.exit(0);
`, 'utf8');

let fakeOpencode;
if (process.platform === 'win32') {
  fakeOpencode = resolve(dir, 'fake-opencode.cmd');
  writeFileSync(fakeOpencode, `@echo off\r\n"${process.execPath}" "%~dp0fake-opencode.cjs" %*\r\n`, 'utf8');
} else {
  fakeOpencode = resolve(dir, 'fake-opencode');
  writeFileSync(fakeOpencode, `#!/usr/bin/env bash\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.cjs" "$@"\n`, 'utf8');
  chmodSync(fakeOpencode, 0o755);
}

process.env.AGENT_LOOP_WORKER_EXECUTABLE = fakeOpencode;
process.env.AGENT_LOOP_FAKE_LOG = fakeLog;
process.env.AGENT_LOOP_FORK_DISABLED = '1';
process.env.AGENT_LOOP_BUDGET_STATE_PATH = resolve(dir, 'budgets.json');
process.env.AGENT_LOOP_EVENT_LOG_PATH = resolve(dir, 'events.jsonl');

const plugin = await AgentLoopPlugin();
assert.ok(plugin.tool.agent_loop, 'agent_loop tool should be registered');

const result = await plugin.tool.agent_loop.execute({ task: 'harmless smoke task', mode: 'build', maxRetries: 0 }, {
  directory: dir,
  worktree: dir,
  sessionID: 'parent-session',
  messageID: 'message-1',
  agent: 'orchestrator',
  abort: new AbortController().signal,
  metadata: () => {}
});
const parsed = JSON.parse(result.output);
assert.equal(parsed.status, 'completed');
assert.match(parsed.successfulModel, /.+/);
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

process.env.AGENT_LOOP_CHILD = '1';
const blocked = await plugin.tool.agent_loop.execute({ task: 'nested', mode: 'build' }, {
  directory: dir,
  worktree: dir,
  sessionID: 'parent-session',
  messageID: 'message-2',
  agent: 'build-worker',
  abort: new AbortController().signal,
  metadata: () => {}
});
delete process.env.AGENT_LOOP_CHILD;
assert.equal(JSON.parse(blocked.output).code, 'AGENT_LOOP_RECURSION_BLOCKED');

for (const key of ['AGENT_LOOP_WORKER_EXECUTABLE', 'AGENT_LOOP_FAKE_LOG', 'AGENT_LOOP_FORK_DISABLED', 'AGENT_LOOP_BUDGET_STATE_PATH', 'AGENT_LOOP_EVENT_LOG_PATH']) delete process.env[key];
rmSync(dir, { recursive: true, force: true });
console.log('tool-integration-tests: passed');
