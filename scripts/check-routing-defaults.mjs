#!/usr/bin/env node

import fs from 'node:fs';

const pools = JSON.parse(fs.readFileSync('config/free-first-pools.json', 'utf8'));
const runtimeKeys = new Set([
  'cooldown_until',
  'consecutive_failures',
  'last_failure_reason',
  'last_health_check'
]);

let failed = false;

for (const [poolName, pool] of Object.entries(pools.pools ?? {})) {
  for (const model of pool.models ?? []) {
    for (const key of runtimeKeys) {
      if (Object.hasOwn(model, key)) {
        console.error(`FAIL: ${poolName}/${model.model_id} contains runtime field ${key}`);
        failed = true;
      }
    }
  }
}

const orchestratorPrimary = pools.pools?.orchestrator?.models?.find(
  model => model.role === 'primary' && model.enabled !== false
)?.model_id;

if (orchestratorPrimary !== 'opencode-go/deepseek-v4-flash') {
  console.error(
    `FAIL: orchestrator primary is ${orchestratorPrimary ?? 'missing'}; expected opencode-go/deepseek-v4-flash`
  );
  failed = true;
}

if (failed) process.exit(1);
console.log('Routing defaults contain no mutable cooldown or failure state.');
