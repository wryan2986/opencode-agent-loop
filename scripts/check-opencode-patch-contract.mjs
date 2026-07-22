#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || 'upstream-opencode');
const checks = [
  ['packages/opencode/src/cli/cmd/run.ts', ['enhanceErrorForJson', 'classification', 'retryAfterMs', 'providerID', 'modelID']],
  ['packages/opencode/src/session/message-v2.ts', ['providerID', 'modelID']],
  ['packages/opencode/src/session/processor.ts', ['taskFailure']],
  ['packages/opencode/src/session/prompt.ts', ['taskFailure']],
  ['packages/opencode/test/cli/run/error-metadata.test.ts', ['rate-limit', 'retryAfterMs']]
];

let failed = false;
for (const [relative, markers] of checks) {
  const path = resolve(root, relative);
  if (!existsSync(path)) {
    console.error(`FAIL: missing patched file ${relative}`);
    failed = true;
    continue;
  }
  const content = readFileSync(path, 'utf8');
  for (const marker of markers) {
    if (!content.includes(marker)) {
      console.error(`FAIL: ${relative} missing marker ${marker}`);
      failed = true;
    }
  }
  if (!failed) console.log(`OK: ${relative}`);
}

if (failed) process.exit(1);
console.log('OpenCode patch contract verified.');
