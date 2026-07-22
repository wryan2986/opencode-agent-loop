#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const orchestrator = readFileSync(resolve(root, 'agents/orchestrator.md'), 'utf8');
const feature = readFileSync(resolve(root, 'commands/feature.md'), 'utf8');
const opencode = JSON.parse(readFileSync(resolve(root, 'opencode.json'), 'utf8'));

const failures = [];
function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) failures.push(message);
}

requireMatch(orchestrator, /^\s*agent_loop:\s*allow\s*$/m, 'orchestrator must allow agent_loop');
requireMatch(orchestrator, /^\s*task:\s*deny\s*$/m, 'orchestrator must deny direct task delegation');
requireMatch(orchestrator, /same stable task ID|same `taskId`/i, 'orchestrator must require one stable task ID');
requireMatch(orchestrator, /BUDGET_EXCEEDED[\s\S]{0,240}(terminal|stop)/i, 'orchestrator must stop on BUDGET_EXCEEDED');
requireMatch(feature, /same stable `taskId`|same `taskId`/i, '/feature must require taskId reuse');
requireMatch(feature, /must not use the built-in `task` tool/i, '/feature must prohibit direct task delegation');
requireMatch(feature, /BUDGET_EXCEEDED/i, '/feature must define budget-exhaustion behavior');

const instructions = Array.isArray(opencode.instructions) ? opencode.instructions.join('\n') : '';
requireMatch(instructions, /delegate through the agent_loop custom tool/i, 'opencode.json must direct /feature through agent_loop');
requireMatch(instructions, /stable taskId/i, 'opencode.json must require a stable taskId');
requireMatch(instructions, /BUDGET_EXCEEDED as terminal/i, 'opencode.json must make budget exhaustion terminal');

if (failures.length > 0) {
  for (const failure of failures) console.error(`feature-contract: ${failure}`);
  process.exit(1);
}

console.log('feature-contract: valid');
