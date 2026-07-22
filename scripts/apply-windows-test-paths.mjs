#!/usr/bin/env node

import fs from 'node:fs';

const path = 'tests/runtime-tests.mjs';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
  "import { resolve, join } from 'node:path';",
  "import { resolve, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';"
);
content = content.replace(
  "import {\n  loadState,",
  "const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));\n\nimport {\n  loadState,"
);
content = content.replaceAll(
  "resolve(new URL('..', import.meta.url).pathname, 'opencode.json')",
  "resolve(PACKAGE_ROOT, 'opencode.json')"
);
content = content.replaceAll(
  "resolve(new URL('..', import.meta.url).pathname, 'agents/review.md')",
  "resolve(PACKAGE_ROOT, 'agents/review.md')"
);
fs.writeFileSync(path, content);
console.log('Windows-safe test paths applied.');
