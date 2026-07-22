import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import AgentLoopPlugin from '../.opencode/plugins/agent-loop.js';

const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-tool-'));
const fakeOpencode = resolve(dir, 'fake-opencode.js');
const fakeLog = resolve(dir, 'fake-opencode.jsonl');
writeFileSync(fakeOpencode, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.AGENT_LOOP_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), child: process.env.AGENT_LOOP_CHILD, taskId: process.env.AGENT_LOOP_TASK_ID, smokeTest: process.env.AGENT_LOOP_SMOKE_TEST || '' }) + '\\n');
console.log(JSON.stringify({ type: 'step_start', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p1', type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p2', type: 'text', text: 'ok' } }));
console.log(JSON.stringify({ type: 'step_finish', timestamp: Date.now(), sessionID: 'fake-session', part: { id: 'p3', reason: 'stop' } }));
console.log('RESULT: PASS');
process.exit(0);
`, 'utf8');
chmodSync(fakeOpencode, 0o755);

process.env.AGENT_LOOP_WORKER_EXECUTABLE = fakeOpencode;
process.env.AGENT_LOOP_FAKE_LOG = fakeLog;
// Run directly (no session forking) in test environment
process.env.AGENT_LOOP_FORK_DISABLED = '1';

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
const calls = readFileSync(fakeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
// Filter out smoke test calls (they run before the main build step)
const buildCalls = calls.filter(c => !c.smokeTest);
assert.ok(buildCalls.length >= 1, `Expected at least 1 build call, got ${buildCalls.length}`);
const mainCall = buildCalls[buildCalls.length - 1];
assert.equal(mainCall.child, '1');
assert.ok(mainCall.args.includes('--agent'));
assert.ok(mainCall.args.includes('build-worker'));
assert.ok(mainCall.args.includes('--model'));
assert.equal(mainCall.args[mainCall.args.indexOf('--model') + 1], parsed.successfulModel);

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

rmSync(dir, { recursive: true, force: true });
console.log('tool-integration-tests: passed');
