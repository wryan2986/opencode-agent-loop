#!/usr/bin/env node

import fs from 'node:fs';

function writeIfChanged(path, next) {
  const current = fs.readFileSync(path, 'utf8');
  if (current === next) return false;
  fs.writeFileSync(path, next);
  console.log(`Updated ${path}`);
  return true;
}

function cleanRuntimeState(value) {
  if (Array.isArray(value)) return value.map(cleanRuntimeState);
  if (!value || typeof value !== 'object') return value;

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'cooldown_until' ||
      key === 'consecutive_failures' ||
      key === 'last_failure_reason' ||
      key === 'last_health_check'
    ) {
      continue;
    }
    next[key] = cleanRuntimeState(child);
  }
  return next;
}

function normalizeOrchestrator() {
  const path = 'agents/orchestrator.md';
  const current = fs.readFileSync(path, 'utf8');
  const match = current.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${path} has no valid frontmatter`);

  let lines = match[1].split(/\r?\n/);

  // Remove the unsupported permission.git block and its children.
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '  git:') continue;
    let end = index + 1;
    while (end < lines.length && /^ {4}/.test(lines[end])) end += 1;
    lines.splice(index, end - index);
    index -= 1;
  }

  const bashIndex = lines.indexOf('  bash:');
  if (bashIndex < 0) throw new Error(`${path} has no permission.bash block`);

  let bashEnd = bashIndex + 1;
  while (bashEnd < lines.length && /^ {4}/.test(lines[bashEnd])) bashEnd += 1;

  const bashLines = lines.slice(bashIndex + 1, bashEnd);
  const additions = [];

  if (!bashLines.some(line => /^    ["']\*["']:[ ]*(ask|deny|allow)$/.test(line))) {
    additions.push('    "*": ask');
  }
  if (!bashLines.some(line => /git commit\\?\*/.test(line) && /allow$/.test(line))) {
    additions.push('    "git commit*": allow');
  }

  for (const command of ['push', 'reset', 'clean', 'checkout', 'restore']) {
    const exists = bashLines.some(
      line => line.includes(`git ${command}*`) && /deny$/.test(line)
    );
    if (!exists) additions.push(`    "git ${command}*": deny`);
  }

  lines.splice(bashIndex + 1, 0, ...additions.filter(line => line.includes('"*"')));

  // Recalculate the end after the wildcard insertion and append specific rules.
  let updatedBashEnd = bashIndex + 1;
  while (updatedBashEnd < lines.length && /^ {4}/.test(lines[updatedBashEnd])) {
    updatedBashEnd += 1;
  }
  const specific = additions.filter(line => !line.includes('"*"'));
  lines.splice(updatedBashEnd, 0, ...specific);

  const replacement = `---\n${lines.join('\n')}\n---`;
  return writeIfChanged(path, current.replace(match[0], replacement));
}

let changed = false;
changed = normalizeOrchestrator() || changed;

for (const path of ['config/free-first-pools.json', 'config/model-registry.json']) {
  const current = JSON.parse(fs.readFileSync(path, 'utf8'));
  const cleaned = cleanRuntimeState(current);
  changed = writeIfChanged(path, `${JSON.stringify(cleaned, null, 2)}\n`) || changed;
}

const changelogPath = 'CHANGELOG.md';
const changelog = fs.readFileSync(changelogPath, 'utf8');
const finalizedChangelog = changelog.replace(
  '## [Unreleased]',
  '## [0.1.1] - 2026-07-22'
);
changed = writeIfChanged(changelogPath, finalizedChangelog) || changed;

const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lock.name = 'opencode-agent-loop';
lock.version = '0.1.1';
lock.packages ??= {};
lock.packages[''] ??= {};
lock.packages[''].name = 'opencode-agent-loop';
lock.packages[''].version = '0.1.1';
changed = writeIfChanged(lockPath, `${JSON.stringify(lock, null, 2)}\n`) || changed;

if (!changed) console.log('Release files already finalized.');
