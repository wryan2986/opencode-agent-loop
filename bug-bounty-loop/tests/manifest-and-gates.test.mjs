import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, evaluateUrlScope } from '../lib/manifest.mjs';
import { evaluateSubmissionGates } from '../lib/gates.mjs';

function validManifest() {
  return {
    schema_version: 1,
    mode: 'authorized_program',
    program: {
      name: 'Example',
      platform: 'direct',
      policy_url: 'https://example.com/security',
      policy_snapshot_date: '2026-07-23',
    },
    authorization: {
      confirmed: true,
      confirmed_by: 'Researcher',
      testing_identity: 'researcher-id',
      notes: '',
    },
    scope: {
      allowed_origins: ['https://example.com'],
      allowed_path_prefixes: ['/api'],
      excluded_origins: [],
      excluded_path_prefixes: ['/api/admin'],
      allowed_methods: ['GET', 'HEAD', 'OPTIONS'],
      max_requests_per_minute: 6,
      max_total_requests_per_case: 40,
      max_response_bytes: 1024 * 1024,
      follow_redirects: false,
      allow_private_networks: false,
      identification_headers: { 'X-Bug-Bounty': 'researcher-id' },
    },
    safety: {
      only_owned_test_accounts: true,
      allow_state_change: false,
      stop_on_real_user_data: true,
      stop_on_service_instability: true,
      prohibited_tests: ['denial of service'],
    },
    reporting: {
      human_approval_required: true,
      auto_submit: false,
    },
  };
}

test('valid manifest normalizes and passes', () => {
  const result = validateManifest(validManifest());
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.manifest.scope.allowed_origins, ['https://example.com']);
});

test('manifest rejects automatic submission and unconfirmed authorization', () => {
  const manifest = validManifest();
  manifest.authorization.confirmed = false;
  manifest.reporting.auto_submit = true;
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /authorization\.confirmed/);
  assert.match(result.errors.join('\n'), /auto_submit/);
});

test('manifest rejects state-changing methods unless explicitly allowed', () => {
  const manifest = validManifest();
  manifest.scope.allowed_methods.push('POST');
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /state-changing/);
});

test('scope is exact by origin and path', () => {
  const manifest = validateManifest(validManifest()).manifest;
  assert.equal(evaluateUrlScope(manifest, 'https://example.com/api/items/1', 'GET').allowed, true);
  assert.equal(evaluateUrlScope(manifest, 'https://sub.example.com/api/items/1', 'GET').allowed, false);
  assert.equal(evaluateUrlScope(manifest, 'https://example.com/api/admin/users', 'GET').allowed, false);
  assert.equal(evaluateUrlScope(manifest, 'https://example.com/public', 'GET').allowed, false);
});

test('all-pass gate yields READY_FOR_HUMAN_REVIEW', () => {
  const manifest = validateManifest(validManifest()).manifest;
  const result = evaluateSubmissionGates({
    manifest,
    candidate: { url: 'https://example.com/api/items/1', method: 'GET' },
    reproduction: {
      reproduced: true,
      fresh_state_reproduced: true,
      negative_control_passed: true,
      controlled_accounts_only: true,
      unauthorized_data_observed: false,
      service_instability_observed: false,
      evidence_refs: ['evidence/repro-1.json', 'evidence/control.json'],
    },
    verification: {
      independent: true,
      reproduced: true,
      fresh_state: true,
      negative_control: true,
      security_boundary_crossed: true,
      intended_behavior_likely: false,
      evidence_refs: ['evidence/verify.json'],
    },
    impact: {
      concrete_impact: true,
      affected_security_properties: ['confidentiality'],
      requires_unrealistic_cooperation: false,
      excluded_by_policy: false,
      duplicate_likely: false,
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.status, 'READY_FOR_HUMAN_REVIEW');
});

test('one uncertain control quarantines the candidate', () => {
  const manifest = validateManifest(validManifest()).manifest;
  const result = evaluateSubmissionGates({
    manifest,
    candidate: { url: 'https://example.com/api/items/1', method: 'GET' },
    reproduction: {
      reproduced: true,
      fresh_state_reproduced: true,
      negative_control_passed: false,
      controlled_accounts_only: true,
      unauthorized_data_observed: false,
      service_instability_observed: false,
      evidence_refs: ['evidence/repro.json'],
    },
    verification: {
      independent: true,
      reproduced: true,
      fresh_state: true,
      negative_control: true,
      security_boundary_crossed: true,
      intended_behavior_likely: false,
      evidence_refs: ['evidence/verify.json'],
    },
    impact: {
      concrete_impact: true,
      affected_security_properties: ['confidentiality'],
      requires_unrealistic_cooperation: false,
      excluded_by_policy: false,
      duplicate_likely: false,
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.status, 'QUARANTINED');
  assert.match(result.failures.join('\n'), /negative control/);
});
