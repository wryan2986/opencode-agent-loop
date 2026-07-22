#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || 'upstream-opencode');
const checks = [
  {
    path: 'packages/opencode/src/cli/cmd/run.ts',
    markers: [
      'function enhanceErrorForJson',
      'classification: classifyError',
      'result.retryAfterMs',
      'result.providerID',
      'result.modelID',
      'args.format === "json"'
    ]
  },
  {
    path: 'packages/opencode/src/session/message-v2.ts',
    markers: [
      'modelID?: ModelV2.ID',
      'providerID: ctx.providerID',
      'ctx.modelID ? { modelID: ctx.modelID }'
    ]
  },
  {
    path: 'packages/opencode/src/session/processor.ts',
    markers: ['modelID: input.model.id']
  },
  {
    path: 'packages/opencode/src/session/prompt.ts',
    markers: ['modelID: msg.modelID']
  },
  {
    path: 'packages/opencode/test/cli/run/error-metadata.test.ts',
    markers: [
      'adds rate-limit metadata without removing the raw error',
      'expect(event?.classification).toBe("rate-limit")',
      'expect(event?.providerID).toBe("test")',
      'expect(event?.modelID).toBe("test-model")'
    ]
  }
];

let failed = false;
for (const check of checks) {
  const path = resolve(root, check.path);
  if (!existsSync(path)) {
    console.error(`FAIL: missing patched file ${check.path}`);
    failed = true;
    continue;
  }

  const content = readFileSync(path, 'utf8');
  let fileFailed = false;
  for (const marker of check.markers) {
    if (!content.includes(marker)) {
      console.error(`FAIL: ${check.path} missing marker ${marker}`);
      failed = true;
      fileFailed = true;
    }
  }
  if (!fileFailed) console.log(`OK: ${check.path}`);
}

if (failed) process.exit(1);
console.log('OpenCode patch contract verified.');
