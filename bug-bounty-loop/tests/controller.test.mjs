import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const controller = path.resolve(testDir, '..', 'bin', 'bounty-loop.mjs');
const example = path.resolve(testDir, '..', 'config', 'local-lab.example.json');

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [controller, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('init creates manifest and scoped wrapper', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-controller-'));
  const result = await run(['init', '--workspace', workspace], workspace);
  assert.equal(result.code, 0, result.stderr);
  await fs.access(path.join(workspace, '.bounty-loop', 'program.json'));
  await fs.access(path.join(workspace, '.bounty-loop', 'tooling', 'bounty-http.mjs'));
});

test('dry run validates a confirmed manifest without invoking OpenCode', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-controller-'));
  await fs.mkdir(path.join(workspace, '.bounty-loop'), { recursive: true });
  await fs.copyFile(example, path.join(workspace, '.bounty-loop', 'program.json'));
  const result = await run([
    'run',
    '--workspace', workspace,
    '--objective', 'Validate local object authorization',
    '--dry-run',
  ], workspace);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'DRY_RUN_VALIDATED');
  assert.deepEqual(output.stages, [
    'discovery',
    'reproduction',
    'blind_verification',
    'impact_review',
    'deterministic_gate',
    'report_draft',
    'human_review',
  ]);
});

test('full controller run keeps submission manual and writes a report after all gates pass', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-controller-'));
  await fs.mkdir(path.join(workspace, '.bounty-loop'), { recursive: true });
  await fs.copyFile(example, path.join(workspace, '.bounty-loop', 'program.json'));

  const fakeOpenCode = path.join(workspace, 'fake-opencode.mjs');
  await fs.writeFile(fakeOpenCode, `#!/usr/bin/env node
const args = process.argv.slice(2);
const agent = args[args.indexOf('--agent') + 1];
const outputs = {
  'bounty-discovery': { candidates: [{ id: 'idor-test', title: 'Test object authorization', url: 'http://127.0.0.1:3000/api/items/2', method: 'GET', hypothesis: 'test user A may read test user B object', preconditions: ['two controlled users'], planned_checks: ['request A object', 'negative control'], confidence: 0.6 }] },
  'bounty-reproduction': { reproduced: true, fresh_state_reproduced: true, negative_control_passed: true, controlled_accounts_only: true, unauthorized_data_observed: false, service_instability_observed: false, evidence_refs: ['evidence/repro.json', 'evidence/control.json'], observed_result: 'controlled cross-account object was returned', rejection_reason: '' },
  'bounty-verifier': { independent: true, reproduced: true, fresh_state: true, negative_control: true, security_boundary_crossed: true, intended_behavior_likely: false, evidence_refs: ['evidence/verify.json'], disproof_attempts: ['tested public visibility'], rejection_reason: '' },
  'bounty-impact': { concrete_impact: true, affected_security_properties: ['confidentiality'], attacker_capability: 'authenticated test user', victim_role: 'another test user', requires_unrealistic_cooperation: false, excluded_by_policy: false, duplicate_likely: false, severity: 'medium', reasoning_summary: 'cross-account read' },
  'bounty-report': { title: 'Cross-account object read', markdown: '# Summary\\nA controlled cross-account read was independently reproduced.\\n', suggested_severity: 'medium', cwe: 'CWE-639', reviewer_notes: [] }
};
if (!outputs[agent]) process.exit(3);
process.stdout.write(JSON.stringify(outputs[agent]));
`, { mode: 0o700 });

  const child = spawn(process.execPath, [controller,
    'run',
    '--workspace', workspace,
    '--objective', 'Validate local object authorization',
    '--case-id', 'integration-case',
  ], {
    cwd: workspace,
    env: { ...process.env, OPENCODE_BIN: fakeOpenCode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  assert.equal(code, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.status, 'READY_FOR_HUMAN_REVIEW');
  assert.deepEqual(output.ready_for_human_review, ['idor-test']);
  assert.match(output.note, /No report was submitted/);
  const report = await fs.readFile(path.join(workspace, '.bounty-loop', 'cases', 'integration-case', 'reports', 'idor-test.md'), 'utf8');
  assert.match(report, /cross-account read/i);
  const state = JSON.parse(await fs.readFile(path.join(workspace, '.bounty-loop', 'cases', 'integration-case', 'state.json'), 'utf8'));
  assert.equal(state.status, 'READY_FOR_HUMAN_REVIEW');
});
