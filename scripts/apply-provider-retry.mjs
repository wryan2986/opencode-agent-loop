#!/usr/bin/env node

import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const write = (path, content) => { fs.writeFileSync(path, content); console.log(`updated ${path}`); };

let execute = read('runtime/execute-agent-task.mjs');
execute = execute.replace(
  "import { AgentLoopEventLogger, redactSensitive } from '../lib/event-log.mjs';",
  "import { AgentLoopEventLogger, redactSensitive } from '../lib/event-log.mjs';\nimport { resolveProviderAdapter } from '../lib/provider-adapters.mjs';"
);
execute = execute.replace(
  "      let finalInvocation = null;\n\n      for (let retryIndex = 0; retryIndex <= retryLimit; retryIndex += 1) {",
  "      let finalInvocation = null;\n      const providerAdapter = resolveProviderAdapter(modelId);\n      const providerPolicy = freeFirstConfig?.provider_retry?.[providerAdapter.id] || {};\n      const adapterRetryPolicy = providerAdapter.retryPolicy(freeFirstConfig.retry || {}, providerPolicy);\n      const modelRetryLimit = Number.isInteger(adapterRetryPolicy.maxRetries)\n        ? Math.min(retryLimit, Math.max(0, adapterRetryPolicy.maxRetries))\n        : retryLimit;\n\n      for (let retryIndex = 0; retryIndex <= modelRetryLimit; retryIndex += 1) {"
);
execute = execute.replace(
  "        const classification = failover.classifyFailure(invocation);\n        if (!classification.retryable || retryIndex >= retryLimit) break;",
  "        const classification = failover.classifyFailure(invocation);\n        const adapterDecision = providerAdapter.shouldRetry(invocation, freeFirstConfig.retry || {}, providerPolicy);\n        const retryable = adapterDecision ?? classification.retryable;\n        if (!retryable || retryIndex >= modelRetryLimit) break;"
);
write('runtime/execute-agent-task.mjs', execute);

const configPath = 'config/free-first-config.json';
const config = JSON.parse(read(configPath));
config.provider_retry = {
  local: {
    max_retries: 1,
    retryable_errors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'],
    non_retryable_errors: ['UNAUTHORIZED', 'FORBIDDEN', 'BUDGET_EXCEEDED']
  },
  nvidia: { max_retries: 2 },
  cerebras: { max_retries: 2 },
  groq: { max_retries: 1 },
  openrouter: { max_retries: 1 },
  opencode: { max_retries: 1 },
  'opencode-go': { max_retries: 2 },
  openai: { max_retries: 2 }
};
write(configPath, `${JSON.stringify(config, null, 2)}\n`);

const schemaPath = 'config/free-first-config-schema.json';
const schema = JSON.parse(read(schemaPath));
schema.properties.provider_retry = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: {
      max_retries: { type: 'integer', minimum: 0, maximum: 5 },
      retryable_http_codes: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
      retryable_errors: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      non_retryable_errors: { type: 'array', items: { type: 'string' }, uniqueItems: true }
    },
    additionalProperties: false
  }
};
write(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

let docs = read('docs/provider-adapters.md');
docs += `\n## Provider-specific retry policy\n\nUse the optional \`provider_retry\` map in \`config/free-first-config.json\` to cap retries or override retryable and non-retryable codes for one provider. The adapter combines that policy with the global retry defaults. A provider-specific cap can reduce, but cannot increase, the caller's \`maxRetries\` value.\n`;
write('docs/provider-adapters.md', docs);

console.log('provider retry integration applied');
