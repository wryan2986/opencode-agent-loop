#!/usr/bin/env node

import fs from 'node:fs';

const path = 'runtime/execute-agent-task.mjs';
const content = fs.readFileSync(path, 'utf8');
const before = '  maxRetries,\n  eventLogger\n}) {';
const after = '  maxRetries = 0,\n  eventLogger\n}) {';
if (!content.includes(before)) throw new Error('Expected executeAgentTask retry signature not found');
fs.writeFileSync(path, content.replace(before, after));
console.log('Low-level executor default restored; controller still passes configured retry value.');
