#!/usr/bin/env node

import fs from 'node:fs';

const executePath = 'runtime/execute-agent-task.mjs';
let execute = fs.readFileSync(executePath, 'utf8');
const before = '  const paidFallback = new PaidFallbackController(configPath);';
const after = '  const paidFallback = new PaidFallbackController(configPath, { cwd });';
if (!execute.includes(before)) throw new Error('PaidFallbackController construction not found');
fs.writeFileSync(executePath, execute.replace(before, after));

const configPath = 'config/free-first-config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.general.paid_fallback_log_path = '.opencode/agent-loop-state/paid-escalations.jsonl';
config.general.paid_fallback_state_path = '.opencode/agent-loop-state/paid-fallback-state.json';
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const docsPath = 'docs/configuration.md';
let docs = fs.readFileSync(docsPath, 'utf8');
const marker = '## Structured events\n';
const section = `## Paid fallback audit state\n\nPaid fallback selections and call counters are persisted per project under \`.opencode/agent-loop-state/\`. The audit log contains only model, role, failure-code, and outcome metadata; it excludes prompts and credentials. Persistent counters prevent a process restart from resetting per-task or global paid-call ceilings.\n\n`;
if (!docs.includes(section)) {
  if (!docs.includes(marker)) throw new Error('Configuration documentation marker not found');
  docs = docs.replace(marker, `${section}${marker}`);
  fs.writeFileSync(docsPath, docs);
}

console.log('Paid fallback state migration applied.');
