#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

const orchestrator = read('agents/orchestrator.md');
const feature = read('commands/feature.md');
const projectFeature = read('.opencode/command/feature.md');
const loop = read('commands/loop.md');
const reviewer = read('agents/review.md');
const tester = read('agents/test.md');
const builder = read('agents/build-worker.md');
const plugin = read('.opencode/plugins/agent-loop.js');
const kernel = read('lib/orchestration-policy.mjs');
const policyConfig = JSON.parse(read('config/orchestration-policy.json'));
const opencode = JSON.parse(read('opencode.json'));

const failures = [];
function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) failures.push(message);
}
function rejectMatch(text, pattern, message) {
  if (pattern.test(text)) failures.push(message);
}

requireMatch(orchestrator, /^steps:\s*(?:[1-9][0-9]?|100)\s*$/m, 'orchestrator steps must be capped at 100');
requireMatch(orchestrator, /^\s*orchestration_policy:\s*allow\s*$/m, 'orchestrator must allow orchestration_policy');
requireMatch(orchestrator, /^\s*orchestration_commit:\s*allow\s*$/m, 'orchestrator must allow orchestration_commit');
requireMatch(orchestrator, /^\s*agent_loop:\s*allow\s*$/m, 'orchestrator must allow agent_loop');
requireMatch(orchestrator, /^\s*task:\s*deny\s*$/m, 'orchestrator must deny direct task delegation');
requireMatch(orchestrator, /^\s*"git commit\*":\s*deny\s*$/m, 'orchestrator must deny direct git commit');
requireMatch(orchestrator, /one stable `taskId`|one stable task ID/i, 'orchestrator must require one stable task ID');
requireMatch(orchestrator, /You propose; the kernel validates/i, 'orchestrator must describe the hybrid authority boundary');
requireMatch(orchestrator, /policyPermit/i, 'orchestrator must pass one-time policy permits');
requireMatch(orchestrator, /needs_evidence/i, 'orchestrator must handle missing-evidence decisions');
requireMatch(orchestrator, /kernel may elevate[\s\S]{0,80}must not lower/i, 'orchestrator must preserve asymmetric risk elevation');
requireMatch(orchestrator, /workflow is not a universal fixed pipeline/i, 'orchestrator must retain flexible action selection');
requireMatch(orchestrator, /stage_candidate/i, 'orchestrator must register staged candidates');
requireMatch(orchestrator, /orchestration_commit/i, 'orchestrator must use policy-controlled commit');
requireMatch(orchestrator, /BUDGET_EXCEEDED[\s\S]{0,240}(terminal|final)/i, 'orchestrator must stop on BUDGET_EXCEEDED');
requireMatch(orchestrator, /do not parallelize|one delegated role at a time/i, 'orchestrator must prohibit shared-worktree parallel agents');

for (const [name, text] of [
  ['commands/feature.md', feature],
  ['.opencode/command/feature.md', projectFeature],
  ['commands/loop.md', loop]
]) {
  requireMatch(text, /stable `taskId`|stable task ID/i, `${name} must require taskId reuse`);
  requireMatch(text, /orchestration_policy/i, `${name} must use orchestration_policy`);
  requireMatch(text, /policyPermit|policy permit/i, `${name} must pass policy permits`);
  requireMatch(text, /needs_evidence/i, `${name} must handle missing evidence`);
  requireMatch(text, /stage_candidate|candidate hash/i, `${name} must bind verification to a candidate`);
  requireMatch(text, /built-in `task` tool|built-in task tool/i, `${name} must prohibit direct task delegation`);
}

requireMatch(reviewer, /staged diff is empty|staged candidate is empty/i, 'reviewer must fail closed on an empty staged candidate');
requireMatch(reviewer, /VERDICT:\s*BLOCKED/i, 'reviewer must support BLOCKED for invalid candidates');
requireMatch(reviewer, /intended staged-file list|intended files/i, 'reviewer must compare actual and intended staged files');
requireMatch(reviewer, /changes after this review[\s\S]{0,80}stale/i, 'reviewer must invalidate stale verdicts');

requireMatch(tester, /\.opencode\/agent-loop-state\/test-servers/i, 'test agent must use project-local server ownership state');
requireMatch(tester, /stop every background process you started/i, 'test agent must clean up owned background processes');
requireMatch(builder, /\.opencode\/agent-loop-state\/handoffs/i, 'builder must use project-local handoff state');
rejectMatch(tester, /\/tmp\//i, 'test agent must not prescribe global /tmp paths');
rejectMatch(builder, /\/tmp\//i, 'builder must not prescribe global /tmp paths');

requireMatch(plugin, /orchestration_policy:\s*tool\(/, 'plugin must register orchestration_policy');
requireMatch(plugin, /orchestration_commit:\s*tool\(/, 'plugin must register orchestration_commit');
requireMatch(plugin, /policyPermit/, 'agent_loop tool must accept a policy permit');
requireMatch(plugin, /consumePermit/, 'agent_loop and commit tools must consume permits');
requireMatch(kernel, /mode === 'shadow'/, 'kernel must implement phase 1 shadow mode');
requireMatch(kernel, /mode === 'invariants'/, 'kernel must implement phase 2 invariant enforcement');
requireMatch(kernel, /riskRequirements/, 'kernel must implement phase 3 risk gates');
requireMatch(kernel, /computeStagedCandidate/, 'kernel must bind policy to the staged candidate');
requireMatch(kernel, /recordAgentLoopResult/, 'kernel must record runtime evidence');
requireMatch(kernel, /POLICY_CANDIDATE_CHANGED/, 'commit authorization must fail on candidate drift');

if (!['shadow', 'invariants', 'risk'].includes(policyConfig.mode)) {
  failures.push('orchestration policy mode must be shadow, invariants, or risk');
}
if (policyConfig.require_agent_loop_permit !== true) {
  failures.push('orchestration policy must require agent-loop permits');
}
if (policyConfig.require_policy_commit !== true) {
  failures.push('orchestration policy must require policy-controlled commit');
}
for (const level of ['low', 'medium', 'high', 'critical']) {
  if (!policyConfig.gates?.[level]) failures.push(`orchestration policy must define ${level} risk gates`);
}

const instructions = Array.isArray(opencode.instructions) ? opencode.instructions.join('\n') : '';
requireMatch(instructions, /orchestration_policy/i, 'opencode.json must direct feature work through orchestration_policy');
requireMatch(instructions, /policyPermit/i, 'opencode.json must require policy permits');
requireMatch(instructions, /orchestration_commit/i, 'opencode.json must require policy-controlled commits');
requireMatch(instructions, /stable taskId/i, 'opencode.json must require a stable taskId');
requireMatch(instructions, /BUDGET_EXCEEDED[\s\S]{0,80}terminal/i, 'opencode.json must make budget exhaustion terminal');

if (failures.length > 0) {
  for (const failure of failures) console.error(`feature-contract: ${failure}`);
  process.exit(1);
}

console.log('feature-contract: valid');
