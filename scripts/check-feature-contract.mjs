#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const orchestrator = readFileSync(resolve(root, 'agents/orchestrator.md'), 'utf8');
const feature = readFileSync(resolve(root, 'commands/feature.md'), 'utf8');
const projectFeature = readFileSync(resolve(root, '.opencode/command/feature.md'), 'utf8');
const reviewer = readFileSync(resolve(root, 'agents/review.md'), 'utf8');
const tester = readFileSync(resolve(root, 'agents/test.md'), 'utf8');
const builder = readFileSync(resolve(root, 'agents/build-worker.md'), 'utf8');
const opencode = JSON.parse(readFileSync(resolve(root, 'opencode.json'), 'utf8'));

const failures = [];
function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) failures.push(message);
}
function rejectMatch(text, pattern, message) {
  if (pattern.test(text)) failures.push(message);
}

requireMatch(orchestrator, /^steps:\s*(?:[1-9][0-9]?|100)\s*$/m, 'orchestrator steps must be capped at 100');
requireMatch(orchestrator, /^\s*agent_loop:\s*allow\s*$/m, 'orchestrator must allow agent_loop');
requireMatch(orchestrator, /^\s*task:\s*deny\s*$/m, 'orchestrator must deny direct task delegation');
requireMatch(orchestrator, /same stable task ID|same `taskId`/i, 'orchestrator must require one stable task ID');
requireMatch(orchestrator, /BUDGET_EXCEEDED[\s\S]{0,240}(terminal|stop)/i, 'orchestrator must stop on BUDGET_EXCEEDED');
requireMatch(orchestrator, /baseline/i, 'orchestrator must establish a pre-change baseline');
requireMatch(orchestrator, /git diff --cached --name-only/i, 'orchestrator must verify the staged review candidate');
requireMatch(orchestrator, /do not parallelize/i, 'orchestrator must prohibit shared-worktree parallel agents');
requireMatch(orchestrator, /background process/i, 'orchestrator must account for test-owned background processes');

for (const [name, text] of [['commands/feature.md', feature], ['.opencode/command/feature.md', projectFeature]]) {
  requireMatch(text, /stable `taskId`|stable task ID/i, `${name} must require taskId reuse`);
  requireMatch(text, /do not use|must not use[\s\S]{0,80}(built-in `task` tool|built-in task tool)/i, `${name} must prohibit direct task delegation`);
  requireMatch(text, /BUDGET_EXCEEDED/i, `${name} must define budget-exhaustion behavior`);
  requireMatch(text, /baseline/i, `${name} must define baseline testing`);
  requireMatch(text, /staged|staging/i, `${name} must define a staged review candidate`);
  requireMatch(text, /do not parallelize|one active delegated role/i, `${name} must prohibit unsafe shared-worktree parallelism`);
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

const instructions = Array.isArray(opencode.instructions) ? opencode.instructions.join('\n') : '';
requireMatch(instructions, /delegate through the agent_loop custom tool/i, 'opencode.json must direct /feature through agent_loop');
requireMatch(instructions, /stable taskId/i, 'opencode.json must require a stable taskId');
requireMatch(instructions, /BUDGET_EXCEEDED as terminal/i, 'opencode.json must make budget exhaustion terminal');

if (failures.length > 0) {
  for (const failure of failures) console.error(`feature-contract: ${failure}`);
  process.exit(1);
}

console.log('feature-contract: valid');
