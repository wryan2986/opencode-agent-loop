#!/usr/bin/env node

import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content); console.log(`updated ${path}`); }
function replace(path, before, after) {
  const current = read(path);
  if (!current.includes(before)) throw new Error(`missing expected text in ${path}: ${before.slice(0, 100)}`);
  write(path, current.replace(before, after));
}
function updateJson(path, mutate) {
  const value = JSON.parse(read(path));
  mutate(value);
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Tests should persist only when policy explicitly enables it.
replace('lib/budget-manager.mjs', "persistenceEnabled: raw.persist_state !== false,", "persistenceEnabled: raw.persist_state === true,");

// Use adapters for provider-wide cooldown and portable checkpoint paths.
let failover = read('lib/failover-handler.mjs');
failover = failover.replace(
  "import { resolve } from 'node:path';\n",
  "import { resolve } from 'node:path';\nimport { tmpdir } from 'node:os';\nimport { deriveProviderFromModel } from './provider-adapters.mjs';\n"
);
failover = failover.replace(
  "const RETRYABLE_SYSTEM_ERRORS =",
  "function checkpointPath(taskId) {\n  const safe = String(taskId || 'task').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);\n  return resolve(tmpdir(), `task-checkpoint-${safe}.json`);\n}\n\nconst RETRYABLE_SYSTEM_ERRORS ="
);
failover = failover.replaceAll("modelId.split('/')[0]", "deriveProviderFromModel(modelId)");
failover = failover.replaceAll("`/tmp/task-checkpoint-${taskId}.json`", "checkpointPath(taskId)");
write('lib/failover-handler.mjs', failover);

// Package metadata and portable scripts.
updateJson('package.json', pkg => {
  pkg.version = '0.2.0';
  const reliability = 'node tests/reliability-v020-tests.mjs';
  if (!pkg.scripts.test.includes(reliability)) pkg.scripts.test = `${reliability} && ${pkg.scripts.test}`;
  pkg.scripts.events = 'node scripts/query-events.mjs';
  pkg.scripts['validate:portable'] = 'npm run validate:routing && npm run validate:budget && npm run validate:feature && node scripts/check-doc-links.mjs && npm test';
  pkg.scripts.validate = 'npm run validate:agents && npm run validate:portable';
});
updateJson('package-lock.json', lock => {
  lock.packages[''].version = '0.2.0';
});

// Ignore durable runtime state.
let gitignore = read('.gitignore');
if (!gitignore.includes('.opencode/agent-loop-state/')) {
  gitignore = gitignore.replace('.opencode/agent-loop-logs/\n', '.opencode/agent-loop-logs/\n.opencode/agent-loop-state/\n');
  write('.gitignore', gitignore);
}

// Public tool output and descriptions.
let plugin = read('.opencode/plugins/agent-loop.js');
plugin = plugin.replace("    logPath: result.logPath,\n    budget:", "    logPath: result.logPath,\n    eventLogPath: result.eventLogPath || undefined,\n    budget:");
plugin = plugin.replace("      eventLogPath: s.eventLogPath || undefined,\n      budget:", "      eventLogPath: s.eventLogPath || undefined,\n      budget:");
plugin = plugin.replace('or escalate (GPT-5.5 diagnosis)', 'or escalate (GPT-5.6 diagnosis)');
plugin = plugin.replace('across build, test, and review calls.', 'across smoke, build, test, review, fix, and escalation calls.');
write('.opencode/plugins/agent-loop.js', plugin);

// Bound paid parent orchestration turns.
replace('agents/orchestrator.md', 'steps: 200', 'steps: 100');

// Budget policy validator additions.
let validator = read('scripts/check-budget-config.mjs');
validator = validator.replace(
  "  nonNegativeNumber(budgets.max_cost_usd_per_task, 'budgets.max_cost_usd_per_task', { nullable: true });\n",
  "  nonNegativeNumber(budgets.max_cost_usd_per_task, 'budgets.max_cost_usd_per_task', { nullable: true });\n  nonNegativeNumber(budgets.max_workflow_calls_per_task, 'budgets.max_workflow_calls_per_task', { integer: true, nullable: true });\n  if (budgets.max_workflow_calls_per_task !== null && budgets.max_workflow_calls_per_task < 1) fail('budgets.max_workflow_calls_per_task must be at least 1');\n  if (typeof budgets.persist_state !== 'boolean') fail('budgets.persist_state must be boolean');\n  if (typeof budgets.state_path !== 'string' || !budgets.state_path) fail('budgets.state_path must be a non-empty string');\n"
);
validator = validator.replace(
  "if (!config.retry?.non_retryable_errors?.includes('BUDGET_EXCEEDED')) {",
  "if (config.provider_timeouts_ms?.local !== config.general?.local_model_request_timeout_seconds * 1000) {\n  fail('provider_timeouts_ms.local must match general.local_model_request_timeout_seconds');\n}\nif (!config.events || config.events.schema_version !== '1.0.0') fail('events.schema_version must be 1.0.0');\n\nif (!config.retry?.non_retryable_errors?.includes('BUDGET_EXCEEDED')) {"
);
write('scripts/check-budget-config.mjs', validator);

console.log('v0.2 release migration applied');
