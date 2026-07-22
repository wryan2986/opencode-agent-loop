#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultEventLogPath } from '../lib/event-log.mjs';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') options.help = true;
  else if (arg.startsWith('--')) options[arg.slice(2)] = args[index + 1], index += 1;
}

if (options.help) {
  console.log(`Usage: node scripts/query-events.mjs [options]\n\nOptions:\n  --file PATH\n  --task TASK_ID\n  --type EVENT_TYPE\n  --stage STAGE\n  --role ROLE\n  --model MODEL_ID\n  --limit N\n  --format json|jsonl|summary`);
  process.exit(0);
}

const path = resolve(options.file || defaultEventLogPath());
let lines;
try { lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean); }
catch (error) {
  console.error(`Unable to read event log ${path}: ${error.message}`);
  process.exit(1);
}

const events = [];
for (const line of lines) {
  try {
    const event = JSON.parse(line);
    if (options.task && event.taskId !== options.task) continue;
    if (options.type && event.type !== options.type) continue;
    if (options.stage && event.stage !== options.stage) continue;
    if (options.role && event.role !== options.role) continue;
    if (options.model && event.modelId !== options.model) continue;
    events.push(event);
  } catch {}
}

const limit = Math.max(1, Math.min(Number(options.limit) || 200, 5000));
const selected = events.slice(-limit);
const format = options.format || 'summary';
if (format === 'json') console.log(JSON.stringify(selected, null, 2));
else if (format === 'jsonl') for (const event of selected) console.log(JSON.stringify(event));
else for (const event of selected) console.log(`${event.timestamp} ${event.taskId} ${event.type}${event.stage ? ` stage=${event.stage}` : ''}${event.modelId ? ` model=${event.modelId}` : ''}`);
