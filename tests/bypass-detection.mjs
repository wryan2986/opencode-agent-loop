import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fullyAllowed = new Set([
  'runtime/opencode-worker-runner.mjs',
  'tests/bypass-detection.mjs',
  'scripts/watch-agent-configs.sh'
]);
const narrowExceptions = new Map([
  ['lib/orchestration-policy.mjs', new Set(['child-process-import', 'spawn-sync'])]
]);
const excludedDirs = new Set(['.git', 'node_modules', 'tests', 'docs', 'templates', 'skills', '.opencode/agent-loop-logs', '.opencode/agent-loop-state']);
const excludedFiles = [/README\.md$/, /CHANGELOG\.md$/, /package-lock\.json$/];
const patterns = [
  ['opencode-run', /opencode\s+run/],
  ['spawn', /\bspawn\s*\(/],
  ['spawn-sync', /\bspawnSync\s*\(/],
  ['exec-file', /\bexecFile\s*\(/],
  ['exec', /\bexec\s*\(/],
  ['child-process-import', /child_process/],
  ['opencode-client', /createOpencodeClient/],
  ['opencode-create', /createOpencode\s*\(/]
];

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
  if (fullyAllowed.has(rel)) continue;
  const exceptions = narrowExceptions.get(rel) || new Set();
  const text = readFileSync(file, 'utf8');
  for (const [name, pattern] of patterns) {
    if (exceptions.has(name)) continue;
    if (pattern.test(text)) offenders.push(`${rel}: ${name} ${pattern}`);
  }
}

const policyKernel = readFileSync(resolve(root, 'lib/orchestration-policy.mjs'), 'utf8');
assert.match(policyKernel, /spawnSync\(['"]git['"],\s*args/, 'policy kernel may spawn only the Git executable through runGit');
assert.doesNotMatch(policyKernel, /spawnSync\((?!['"]git['"])/, 'policy kernel must not spawn a non-Git executable');
assert.doesNotMatch(policyKernel, /opencode\s+run|runOpenCodeWorker|createOpencodeClient|createOpencode\s*\(/, 'policy kernel must not invoke OpenCode workers directly');

assert.deepEqual(offenders, [], `Production OpenCode invocation bypass detected:\n${offenders.join('\n')}`);
console.log('bypass-detection: passed');
