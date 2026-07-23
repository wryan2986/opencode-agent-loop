#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultEventLogPath } from '../lib/event-log.mjs';
import { buildPolicyReactionReport, formatPolicyReactionReport } from '../lib/policy-report.mjs';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') options.help = true;
  else if (arg === '--json') options.format = 'json';
  else if (arg.startsWith('--')) {
    options[arg.slice(2)] = args[index + 1];
    index += 1;
  }
}

if (options.help) {
  console.log(`Usage: node scripts/policy-report.mjs [options]

Options:
  --file PATH       Event log path
  --task TASK_ID    Restrict to one task
  --format text|json
  --json            Alias for --format json
  --help            Show this help`);
  process.exit(0);
}

const path = resolve(options.file || defaultEventLogPath());
let lines;
try {
  lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
} catch (error) {
  console.error(`Unable to read event log ${path}: ${error.message}`);
  process.exit(1);
}

const events = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch {}
}

const report = buildPolicyReactionReport(events, { taskId: options.task });
if ((options.format || 'text') === 'json') console.log(JSON.stringify(report, null, 2));
else console.log(formatPolicyReactionReport(report));
