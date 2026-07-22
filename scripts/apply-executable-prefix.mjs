#!/usr/bin/env node

import fs from 'node:fs';

const path = 'runtime/opencode-worker-runner.mjs';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
  "export function deriveProviderFromModel(model) {\n  return deriveProvider(model);\n}\n\nexport function resolveTimeoutMs",
  "export function deriveProviderFromModel(model) {\n  return deriveProvider(model);\n}\n\nexport function parseExecutableArgs(value = process.env.AGENT_LOOP_WORKER_EXECUTABLE_ARGS) {\n  if (Array.isArray(value)) return value.map(String);\n  if (!value) return [];\n  try {\n    const parsed = JSON.parse(value);\n    return Array.isArray(parsed) ? parsed.map(String) : [];\n  } catch {\n    throw new Error('AGENT_LOOP_WORKER_EXECUTABLE_ARGS must be a JSON array of strings');\n  }\n}\n\nexport function resolveTimeoutMs"
);
content = content.replace(
  "  executable = process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode',\n  sessionId,",
  "  executable = process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode',\n  executableArgs,\n  sessionId,"
);
content = content.replace(
  "  const args = [\n    'run',",
  "  const prefixArgs = parseExecutableArgs(executableArgs);\n  const args = [\n    ...prefixArgs,\n    'run',"
);
fs.writeFileSync(path, content);
console.log('portable executable prefix applied');
