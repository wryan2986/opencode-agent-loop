#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'config/free-first-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

function fail(message) {
  console.error(`budget-config: ${message}`);
  process.exitCode = 1;
}

function nonNegativeNumber(value, label, { integer = false, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number${nullable ? ' or null' : ''}`);
    return;
  }
  if (integer && !Number.isInteger(value)) fail(`${label} must be an integer`);
}

if (config.$schema !== './free-first-config-schema.json') {
  fail('free-first-config.json must reference ./free-first-config-schema.json');
}

const schemaPath = resolve(dirname(configPath), config.$schema || '');
if (!existsSync(schemaPath)) fail(`referenced schema does not exist: ${schemaPath}`);
else JSON.parse(readFileSync(schemaPath, 'utf8'));

const budgets = config.budgets;
if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
  fail('budgets must be an object');
} else {
  if (typeof budgets.enabled !== 'boolean') fail('budgets.enabled must be boolean');
  nonNegativeNumber(budgets.max_tokens_per_task, 'budgets.max_tokens_per_task', { integer: true, nullable: true });
  nonNegativeNumber(budgets.max_input_tokens_per_task, 'budgets.max_input_tokens_per_task', { integer: true, nullable: true });
  nonNegativeNumber(budgets.max_output_tokens_per_task, 'budgets.max_output_tokens_per_task', { integer: true, nullable: true });
  nonNegativeNumber(budgets.max_cost_usd_per_task, 'budgets.max_cost_usd_per_task', { nullable: true });
  nonNegativeNumber(budgets.max_workflow_calls_per_task, 'budgets.max_workflow_calls_per_task', { integer: true, nullable: true });
  if (budgets.max_workflow_calls_per_task !== null && budgets.max_workflow_calls_per_task < 1) fail('budgets.max_workflow_calls_per_task must be at least 1');
  if (typeof budgets.persist_state !== 'boolean') fail('budgets.persist_state must be boolean');
  if (typeof budgets.state_path !== 'string' || !budgets.state_path) fail('budgets.state_path must be a non-empty string');
  nonNegativeNumber(budgets.ledger_ttl_minutes, 'budgets.ledger_ttl_minutes', { integer: true });
  nonNegativeNumber(budgets.max_tracked_tasks, 'budgets.max_tracked_tasks', { integer: true });
  if (budgets.ledger_ttl_minutes < 1) fail('budgets.ledger_ttl_minutes must be at least 1');
  if (budgets.max_tracked_tasks < 1) fail('budgets.max_tracked_tasks must be at least 1');
  if (typeof budgets.fail_closed_on_unknown_pricing !== 'boolean') {
    fail('budgets.fail_closed_on_unknown_pricing must be boolean');
  }

  const total = budgets.max_tokens_per_task;
  const input = budgets.max_input_tokens_per_task;
  const output = budgets.max_output_tokens_per_task;
  if (total !== null && input !== null && input > total) {
    fail('input token limit cannot exceed total token limit');
  }
  if (total !== null && output !== null && output > total) {
    fail('output token limit cannot exceed total token limit');
  }
  if (total !== null && input !== null && output !== null && input + output > total) {
    fail('input plus output token limits cannot exceed total token limit');
  }

  const pricing = budgets.unknown_paid_model_pricing;
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    fail('budgets.unknown_paid_model_pricing must be an object');
  } else {
    for (const key of [
      'input_per_million_usd',
      'output_per_million_usd',
      'reasoning_per_million_usd',
      'cache_read_per_million_usd',
      'cache_write_per_million_usd'
    ]) {
      nonNegativeNumber(pricing[key], `budgets.unknown_paid_model_pricing.${key}`);
    }
  }
}

if (config.provider_timeouts_ms?.local !== config.general?.local_model_request_timeout_seconds * 1000) {
  fail('provider_timeouts_ms.local must match general.local_model_request_timeout_seconds');
}
if (!config.events || config.events.schema_version !== '1.0.0') fail('events.schema_version must be 1.0.0');

if (!config.retry?.non_retryable_errors?.includes('BUDGET_EXCEEDED')) {
  fail('retry.non_retryable_errors must include BUDGET_EXCEEDED');
}

if (process.exitCode) process.exit(process.exitCode);
console.log('budget-config: valid');
