#!/usr/bin/env node

import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content); console.log(`updated ${path}`); }
function replace(path, before, after) {
  const current = read(path);
  if (!current.includes(before)) throw new Error(`missing text in ${path}: ${before.slice(0, 120)}`);
  write(path, current.replace(before, after));
}

// Authentication, billing, and safety failures are terminal, even when a
// provider does not supply a structured error code.
let failover = read('lib/failover-handler.mjs');
failover = failover.replace("  /authentication|unauthorized|forbidden/i,\n", '');
failover = failover.replace("  /authentication.*(nvidia|provider|failed)/i,\n", '');
failover = failover.replace(
  "    const nonRetryableErrors = this.config?.retry?.non_retryable_errors || [];\n\n    if (nonRetryableErrors.includes(code)",
  "    const nonRetryableErrors = this.config?.retry?.non_retryable_errors || [];\n\n    if (/authentication|unauthorized|forbidden|invalid api key|invalid token/i.test(message)) {\n      return { retryable: false, reason: 'UNAUTHORIZED', category: 'configuration' };\n    }\n    if (/billing|payment required|insufficient (credit|balance)/i.test(message)) {\n      return { retryable: false, reason: 'BILLING_DISABLED', category: 'configuration' };\n    }\n    if (/safety rejection|content[- ]filter|content policy/i.test(message)) {\n      return { retryable: false, reason: 'SAFETY_REJECTION', category: 'task' };\n    }\n\n    if (nonRetryableErrors.includes(code)"
);
write('lib/failover-handler.mjs', failover);

replace(
  '.opencode/plugins/agent-loop.js',
  "Maximum task-level retry cycles. Provider failover is handled separately.",
  "Maximum same-model retries for transient failures. Provider failover begins after these retries are exhausted."
);

let events = read('lib/event-log.mjs');
events = events.replace(
  "constructor({ taskId, cwd = process.cwd(), path = defaultEventLogPath(cwd) } = {}) {",
  "constructor({ taskId, cwd = process.cwd(), path = defaultEventLogPath(cwd), enabled = true } = {}) {"
);
events = events.replace(
  "    this.path = path;\n    mkdirSync(dirname(path), { recursive: true });",
  "    this.path = path;\n    this.enabled = enabled !== false;\n    if (this.enabled) mkdirSync(dirname(path), { recursive: true });"
);
events = events.replace(
  "    appendFileSync(this.path, `${JSON.stringify(event)}\\n`, { encoding: 'utf8', mode: 0o600 });",
  "    if (this.enabled) appendFileSync(this.path, `${JSON.stringify(event)}\\n`, { encoding: 'utf8', mode: 0o600 });"
);
events = events.replace(
  "  query({ type, stage, role, modelId, limit = 200 } = {}) {\n    let lines = [];",
  "  query({ type, stage, role, modelId, limit = 200 } = {}) {\n    if (!this.enabled) return [];\n    let lines = [];"
);
write('lib/event-log.mjs', events);

let controller = read('runtime/agent-loop-controller.mjs');
controller = controller.replace(
  "import { AgentLoopEventLogger } from '../lib/event-log.mjs';",
  "import { AgentLoopEventLogger, defaultEventLogPath } from '../lib/event-log.mjs';"
);
controller = controller.replace(
  "  const events = new AgentLoopEventLogger({ taskId, cwd });",
  "  const events = new AgentLoopEventLogger({\n    taskId,\n    cwd,\n    enabled: config?.events?.enabled !== false,\n    path: defaultEventLogPath(cwd, config?.events?.path || '.opencode/agent-loop-state/events.jsonl')\n  });"
);
write('runtime/agent-loop-controller.mjs', controller);

let contract = read('scripts/check-feature-contract.mjs');
contract = contract.replace(
  "requireMatch(orchestrator, /^\\s*agent_loop:\\s*allow\\s*$/m,",
  "requireMatch(orchestrator, /^steps:\\s*(?:[1-9][0-9]?|100)\\s*$/m, 'orchestrator steps must be capped at 100');\nrequireMatch(orchestrator, /^\\s*agent_loop:\\s*allow\\s*$/m,"
);
write('scripts/check-feature-contract.mjs', contract);

console.log('final hardening applied');
