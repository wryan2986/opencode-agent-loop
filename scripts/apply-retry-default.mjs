#!/usr/bin/env node

import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const write = (path, content) => { fs.writeFileSync(path, content); console.log(`updated ${path}`); };
const replace = (path, before, after) => {
  const content = read(path);
  if (!content.includes(before)) throw new Error(`missing expected text in ${path}: ${before.slice(0, 120)}`);
  write(path, content.replace(before, after));
};

replace('runtime/execute-agent-task.mjs', '  maxRetries = 0,\n  eventLogger', '  maxRetries,\n  eventLogger');
replace('runtime/execute-agent-task.mjs', "  const retryLimit = Number.isInteger(maxRetries) ? Math.max(0, Math.min(maxRetries, 5)) : 0;\n", '');
replace(
  'runtime/execute-agent-task.mjs',
  "  const freeFirstConfig = loadFreeFirstConfig(configPath);\n  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);",
  "  const freeFirstConfig = loadFreeFirstConfig(configPath);\n  const configuredRetryLimit = Number.isInteger(freeFirstConfig?.retry?.max_retries)\n    ? freeFirstConfig.retry.max_retries\n    : 0;\n  const retryLimit = Number.isInteger(maxRetries)\n    ? Math.max(0, Math.min(maxRetries, 5))\n    : Math.max(0, Math.min(configuredRetryLimit, 5));\n  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);"
);

replace('runtime/agent-loop-controller.mjs', '  maxRetries = 0,\n  cwd', '  maxRetries,\n  cwd');
replace(
  'runtime/agent-loop-controller.mjs',
  "  const config = loadConfig(DEFAULT_CONFIG_PATH);\n  const smokeTestEnabled",
  "  const config = loadConfig(DEFAULT_CONFIG_PATH);\n  const configuredRetryLimit = Number.isInteger(config?.retry?.max_retries) ? config.retry.max_retries : 0;\n  const effectiveMaxRetries = Number.isInteger(maxRetries)\n    ? Math.max(0, Math.min(maxRetries, 5))\n    : Math.max(0, Math.min(configuredRetryLimit, 5));\n  const smokeTestEnabled"
);
replace(
  'runtime/agent-loop-controller.mjs',
  "events.emit('workflow.call', { stage: mode, data: { mode, maxRetries, budget: callBudget } });",
  "events.emit('workflow.call', { stage: mode, data: { mode, maxRetries: effectiveMaxRetries, budget: callBudget } });"
);
replace(
  'runtime/agent-loop-controller.mjs',
  '    maxRetries,\n    eventLogger: events',
  '    maxRetries: effectiveMaxRetries,\n    eventLogger: events'
);

replace('.opencode/plugins/agent-loop.js', '              maxRetries: args.maxRetries || 0,', '              maxRetries: args.maxRetries,');
replace('tests/reliability-v020-tests.mjs', '      max_retries: 2, base_delay_ms: 0,', '      max_retries: 1, base_delay_ms: 0,');
replace('tests/reliability-v020-tests.mjs', '    logDir: dir,\n    maxRetries: 1,\n    workerAdapter:', '    logDir: dir,\n    workerAdapter:');

console.log('retry default migration applied');
