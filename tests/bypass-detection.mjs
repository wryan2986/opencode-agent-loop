import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const allowed = new Set([
  'runtime/opencode-worker-runner.mjs',
  'tests/bypass-detection.mjs',
  'scripts/watch-agent-configs.sh'
]);
const excludedDirs = new Set(['.git', 'node_modules', 'tests', 'docs', 'templates', 'skills', '.opencode/agent-loop-logs']);
const excludedFiles = [/README\.md$/, /CHANGELOG\.md$/, /package-lock\.json$/];
const patterns = [/opencode\s+run/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bexec\s*\(/, /child_process/, /createOpencodeClient/, /createOpencode\s*\(/];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    const rel = relative(root, abs);
    if (rel.split('/').includes('node_modules')) continue;
    if ([...excludedDirs].some(ex => rel === ex || rel.startsWith(`${ex}/`))) continue;
    const stat = statSync(abs);
    if (stat.isDirectory()) walk(abs, out);
    else if (/\.(mjs|js|ts|sh|json)$/.test(entry) && !excludedFiles.some(rx => rx.test(rel))) out.push(abs);
  }
  return out;
}

const offenders = [];
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (allowed.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) offenders.push(`${rel}: ${pattern}`);
  }
}

assert.deepEqual(offenders, [], `Production OpenCode invocation bypass detected:\n${offenders.join('\n')}`);
console.log('bypass-detection: passed');
