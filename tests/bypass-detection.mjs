import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowed = new Set([
  'runtime/opencode-worker-runner.mjs',
  'tests/bypass-detection.mjs',
  'scripts/watch-agent-configs.sh'
]);
const excludedDirs = new Set(['.git', 'node_modules', 'tests', 'docs', 'templates', 'skills', '.opencode/agent-loop-logs', '.opencode/agent-loop-state']);
const excludedFiles = [/README\.md$/, /CHANGELOG\.md$/, /package-lock\.json$/];
const patterns = [/opencode\s+run/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bexec\s*\(/, /child_process/, /createOpencodeClient/, /createOpencode\s*\(/];

function portableRelative(path) {
  return relative(root, path).split(sep).join('/');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    const rel = portableRelative(abs);
    if (rel.split('/').includes('node_modules')) continue;
    if ([...excludedDirs].some(excluded => rel === excluded || rel.startsWith(`${excluded}/`))) continue;
    const stat = statSync(abs);
    if (stat.isDirectory()) walk(abs, out);
    else if (/\.(mjs|js|ts|sh|json)$/.test(entry) && !excludedFiles.some(pattern => pattern.test(rel))) out.push(abs);
  }
  return out;
}

const offenders = [];
for (const file of walk(root)) {
  const rel = portableRelative(file);
  if (allowed.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) offenders.push(`${rel}: ${pattern}`);
  }
}

assert.deepEqual(offenders, [], `Production OpenCode invocation bypass detected:\n${offenders.join('\n')}`);
console.log('bypass-detection: passed');
