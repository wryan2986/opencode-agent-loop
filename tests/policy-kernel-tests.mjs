import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OrchestrationPolicyKernel } from '../lib/orchestration-policy.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function createRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-loop-policy-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Policy Test']);
  git(dir, ['config', 'user.email', 'policy@example.invalid']);
  writeFileSync(resolve(dir, 'README.md'), '# Test\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

function kernel(dir, mode = 'risk') {
  return new OrchestrationPolicyKernel({
    cwd: dir,
    eventLogPath: resolve(dir, 'events.jsonl'),
    config: {
      mode,
      statePath: '.policy-state.json',
      permitTtlSeconds: 600,
      taskTtlMinutes: 60,
      maxTrackedTasks: 100,
      maxFixCycles: 2
    }
  });
}

function approve(instance, taskId, riskLevel = 'medium', plannedPaths = ['src/app.js']) {
  const decision = instance.propose({
    taskId,
    action: 'record_approval',
    reason: 'The user explicitly approved the plan.',
    task: 'Implement the approved change.',
    riskLevel,
    plannedPaths,
    evidence: [{ type: 'approval', status: 'granted', ref: 'user-message-1' }]
  });
  assert.equal(decision.decision, 'allow');
}

function justifyBaselineSkip(instance, taskId, riskLevel = 'medium') {
  return instance.propose({
    taskId,
    action: 'skip_baseline',
    reason: 'A baseline run would not add useful evidence.',
    riskLevel,
    evidence: [{
      type: 'baseline_skip',
      status: 'justified',
      ref: 'documentation-only or non-reproducible setup',
      details: { justification: 'The change has no executable pre-change behavior to reproduce.' }
    }]
  });
}

function stageFile(dir, path, content) {
  writeFileSync(resolve(dir, path), content, 'utf8');
  git(dir, ['add', '--', path]);
}

function runPermitted(instance, proposal, result) {
  assert.equal(proposal.decision, 'allow');
  assert.ok(proposal.permit?.id);
  instance.consumePermit({
    taskId: proposal.state.taskId,
    permitId: proposal.permit.id,
    mode: proposal.permit.mode
  });
  instance.recordAgentLoopResult({
    taskId: proposal.state.taskId,
    permitId: proposal.permit.id,
    mode: proposal.permit.mode,
    result
  });
}

async function testShadowModeObservesWithoutBlocking() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'shadow');
    const decision = instance.propose({
      taskId: 'shadow-task',
      action: 'build',
      reason: 'Try implementation before approval.',
      riskLevel: 'medium',
      plannedPaths: ['src/app.js']
    });
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.enforced, false);
    assert.equal(decision.observedDecision, 'needs_evidence');
    assert.ok(decision.permit?.id);
    assert.ok(decision.advisoryMissingEvidence.some(item => item.includes('approval')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testInvariantModeBlocksMissingApprovalButAdvisesRisk() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'invariants');
    const blocked = instance.propose({
      taskId: 'invariant-task',
      action: 'build',
      reason: 'Implement code.',
      riskLevel: 'medium',
      plannedPaths: ['src/app.js']
    });
    assert.equal(blocked.decision, 'needs_evidence');
    assert.equal(blocked.permit, null);
    assert.ok(blocked.missingEvidence.some(item => item.includes('approval')));

    approve(instance, 'invariant-task');
    const allowed = instance.propose({
      taskId: 'invariant-task',
      action: 'build',
      reason: 'Implement after approval.',
      riskLevel: 'medium',
      plannedPaths: ['src/app.js']
    });
    assert.equal(allowed.decision, 'allow');
    assert.ok(allowed.advisoryMissingEvidence.some(item => item.includes('baseline')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testRiskModeRequiresMediumBaselineOrJustification() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    approve(instance, 'medium-task');
    const blocked = instance.propose({
      taskId: 'medium-task',
      action: 'build',
      reason: 'Implement ordinary source change.',
      riskLevel: 'medium',
      plannedPaths: ['src/app.js']
    });
    assert.equal(blocked.decision, 'needs_evidence');
    assert.ok(blocked.missingEvidence.some(item => item.includes('baseline')));

    const skipped = justifyBaselineSkip(instance, 'medium-task');
    assert.equal(skipped.decision, 'allow');

    const allowed = instance.propose({
      taskId: 'medium-task',
      action: 'build',
      reason: 'Implement after justified baseline skip.',
      riskLevel: 'medium',
      plannedPaths: ['src/app.js']
    });
    assert.equal(allowed.decision, 'allow');
    assert.ok(allowed.permit?.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testKernelElevatesRiskAndRejectsHighRiskSkip() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    const inspected = instance.propose({
      taskId: 'auth-task',
      action: 'inspect',
      reason: 'Inspect login behavior.',
      task: 'Change authentication session handling.',
      riskLevel: 'low',
      plannedPaths: ['src/auth/login.js']
    });
    assert.equal(inspected.effectiveRisk, 'high');
    approve(instance, 'auth-task', 'low', ['src/auth/login.js']);

    const denied = justifyBaselineSkip(instance, 'auth-task', 'low');
    assert.equal(denied.decision, 'deny');
    assert.ok(denied.reasons.some(item => item.includes('cannot skip baseline')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testPermitsAreModeBoundAndSingleUse() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    approve(instance, 'permit-task');
    const proposal = instance.propose({
      taskId: 'permit-task',
      action: 'baseline',
      reason: 'Establish baseline.',
      riskLevel: 'medium'
    });
    assert.equal(proposal.decision, 'allow');
    assert.equal(proposal.permit.mode, 'test');

    assert.throws(() => instance.consumePermit({
      taskId: 'permit-task',
      permitId: proposal.permit.id,
      mode: 'build'
    }), error => error.code === 'POLICY_PERMIT_MODE_MISMATCH');

    instance.consumePermit({
      taskId: 'permit-task',
      permitId: proposal.permit.id,
      mode: 'test'
    });
    assert.throws(() => instance.consumePermit({
      taskId: 'permit-task',
      permitId: proposal.permit.id,
      mode: 'test'
    }), error => error.code === 'POLICY_PERMIT_CONSUMED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCandidateBoundTestReviewAndCommit() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    approve(instance, 'candidate-task');
    justifyBaselineSkip(instance, 'candidate-task');
    stageFile(dir, 'README.md', '# Updated\n');

    const staged = instance.propose({
      taskId: 'candidate-task',
      action: 'stage_candidate',
      reason: 'Register the intended staged candidate.',
      riskLevel: 'medium',
      plannedPaths: ['README.md']
    });
    assert.equal(staged.decision, 'allow');
    const candidateHash = staged.state.candidate.hash;
    assert.match(candidateHash, /^sha256:/);

    const testProposal = instance.propose({
      taskId: 'candidate-task',
      action: 'test',
      reason: 'Verify the staged candidate.',
      riskLevel: 'medium'
    });
    runPermitted(instance, testProposal, {
      status: 'completed',
      tests: { status: 'passed' },
      summary: 'Tests passed.'
    });

    const reviewProposal = instance.propose({
      taskId: 'candidate-task',
      action: 'review',
      reason: 'Review the staged candidate.',
      riskLevel: 'medium'
    });
    runPermitted(instance, reviewProposal, {
      status: 'completed',
      review: { status: 'passed' },
      summary: 'Review passed.'
    });

    const commitProposal = instance.propose({
      taskId: 'candidate-task',
      action: 'commit',
      reason: 'Commit the verified candidate.',
      riskLevel: 'medium'
    });
    assert.equal(commitProposal.decision, 'allow');
    assert.equal(commitProposal.permit.candidateHash, candidateHash);

    stageFile(dir, 'README.md', '# Changed after authorization\n');
    assert.throws(() => instance.consumePermit({
      taskId: 'candidate-task',
      permitId: commitProposal.permit.id,
      action: 'commit'
    }), error => error.code === 'POLICY_CANDIDATE_CHANGED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testHighRiskCommitNeedsIntegrationEvidence() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    approve(instance, 'high-task', 'high', ['src/auth/login.js']);
    instance.propose({
      taskId: 'high-task',
      action: 'record_evidence',
      reason: 'Record reproduced baseline.',
      riskLevel: 'high',
      evidence: [{ type: 'baseline', status: 'reproduced', ref: 'baseline-log' }]
    });
    stageFile(dir, 'README.md', '# Auth documentation update\n');
    const staged = instance.propose({
      taskId: 'high-task',
      action: 'stage_candidate',
      reason: 'Register candidate.',
      riskLevel: 'high',
      plannedPaths: ['src/auth/login.js']
    });
    const hash = staged.state.candidate.hash;

    const testProposal = instance.propose({
      taskId: 'high-task',
      action: 'test',
      reason: 'Run tests.',
      riskLevel: 'high'
    });
    runPermitted(instance, testProposal, {
      status: 'completed',
      tests: { status: 'passed' },
      summary: 'Tests passed.'
    });
    const reviewProposal = instance.propose({
      taskId: 'high-task',
      action: 'review',
      reason: 'Run review.',
      riskLevel: 'high'
    });
    runPermitted(instance, reviewProposal, {
      status: 'completed',
      review: { status: 'passed' },
      summary: 'Review passed.'
    });

    const blocked = instance.propose({
      taskId: 'high-task',
      action: 'commit',
      reason: 'Try commit without integration evidence.',
      riskLevel: 'high'
    });
    assert.equal(blocked.decision, 'needs_evidence');
    assert.ok(blocked.missingEvidence.some(item => item.includes('integration_test')));

    instance.propose({
      taskId: 'high-task',
      action: 'record_evidence',
      reason: 'Record representative integration scenario.',
      riskLevel: 'high',
      evidence: [{
        type: 'integration_test',
        status: 'passed',
        ref: 'integration-command-output',
        candidateHash: hash
      }]
    });
    const allowed = instance.propose({
      taskId: 'high-task',
      action: 'commit',
      reason: 'Commit after integration evidence.',
      riskLevel: 'high'
    });
    assert.equal(allowed.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testBudgetTerminalStopsDelegation() {
  const dir = createRepo();
  try {
    const instance = kernel(dir, 'risk');
    approve(instance, 'budget-task');
    justifyBaselineSkip(instance, 'budget-task');
    instance.propose({
      taskId: 'budget-task',
      action: 'record_evidence',
      reason: 'Record exhausted budget.',
      riskLevel: 'medium',
      evidence: [{ type: 'budget', status: 'exceeded', ref: 'budget-ledger' }]
    });
    const denied = instance.propose({
      taskId: 'budget-task',
      action: 'build',
      reason: 'Attempt to continue.',
      riskLevel: 'medium'
    });
    assert.equal(denied.decision, 'deny');
    assert.ok(denied.reasons.some(item => item.includes('BUDGET_EXCEEDED')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFixCycleLimitPersists() {
  const dir = createRepo();
  try {
    let instance = kernel(dir, 'risk');
    approve(instance, 'fix-task');
    justifyBaselineSkip(instance, 'fix-task');

    for (let index = 0; index < 2; index += 1) {
      const proposal = instance.propose({
        taskId: 'fix-task',
        action: 'fix',
        reason: `Fix cycle ${index + 1}.`,
        riskLevel: 'medium'
      });
      assert.equal(proposal.decision, 'allow');
      instance.consumePermit({
        taskId: 'fix-task',
        permitId: proposal.permit.id,
        mode: 'build'
      });
    }

    instance = kernel(dir, 'risk');
    const denied = instance.propose({
      taskId: 'fix-task',
      action: 'fix',
      reason: 'Third fix cycle.',
      riskLevel: 'medium'
    });
    assert.equal(denied.decision, 'deny');
    assert.ok(denied.reasons.some(item => item.includes('Maximum fix cycles')));
    const persisted = JSON.parse(readFileSync(resolve(dir, '.policy-state.json'), 'utf8'));
    assert.equal(persisted.tasks['fix-task'].fixCycles, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tests = [
  testShadowModeObservesWithoutBlocking,
  testInvariantModeBlocksMissingApprovalButAdvisesRisk,
  testRiskModeRequiresMediumBaselineOrJustification,
  testKernelElevatesRiskAndRejectsHighRiskSkip,
  testPermitsAreModeBoundAndSingleUse,
  testCandidateBoundTestReviewAndCommit,
  testHighRiskCommitNeedsIntegrationEvidence,
  testBudgetTerminalStopsDelegation,
  testFixCycleLimitPersists
];

let passed = 0;
for (const test of tests) {
  await test();
  passed += 1;
  console.log(`OK: ${test.name}`);
}
console.log(`policy-kernel-tests: ${passed}/${tests.length} passed`);
