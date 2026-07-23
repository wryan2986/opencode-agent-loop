import { strict as assert } from 'node:assert';
import { buildPolicyReactionReport, formatPolicyReactionReport } from '../lib/policy-report.mjs';

const events = [
  {
    type: 'policy.proposed',
    taskId: 'task-a',
    timestamp: '2026-07-23T10:00:00.000Z',
    stage: 'build',
    data: {
      proposedRisk: 'low',
      inferredRisk: 'high',
      effectiveRisk: 'high',
      riskReasons: ['authentication path']
    }
  },
  {
    type: 'policy.decision',
    taskId: 'task-a',
    timestamp: '2026-07-23T10:00:00.100Z',
    stage: 'build',
    data: {
      mode: 'risk',
      decision: 'needs_evidence',
      observedDecision: 'needs_evidence',
      enforced: true,
      reasons: [],
      missingEvidence: ['baseline: runtime baseline evidence is required for high-risk work'],
      advisoryMissingEvidence: [],
      permitId: null
    }
  },
  {
    type: 'policy.proposed',
    taskId: 'task-a',
    timestamp: '2026-07-23T10:00:01.100Z',
    stage: 'baseline',
    data: {
      proposedRisk: 'high',
      inferredRisk: 'high',
      effectiveRisk: 'high'
    }
  },
  {
    type: 'policy.decision',
    taskId: 'task-a',
    timestamp: '2026-07-23T10:00:01.200Z',
    stage: 'baseline',
    data: {
      mode: 'risk',
      decision: 'allow',
      observedDecision: 'allow',
      enforced: true,
      reasons: [],
      missingEvidence: [],
      advisoryMissingEvidence: [],
      permitId: 'permit-1'
    }
  },
  {
    type: 'policy.proposed',
    taskId: 'task-b',
    timestamp: '2026-07-23T10:01:00.000Z',
    stage: 'commit',
    data: {
      proposedRisk: 'medium',
      inferredRisk: 'medium',
      effectiveRisk: 'medium'
    }
  },
  {
    type: 'policy.decision',
    taskId: 'task-b',
    timestamp: '2026-07-23T10:01:00.100Z',
    stage: 'commit',
    data: {
      mode: 'shadow',
      decision: 'allow',
      observedDecision: 'needs_evidence',
      enforced: false,
      reasons: [],
      missingEvidence: [],
      advisoryMissingEvidence: ['review: PASS bound to the current candidate'],
      permitId: 'permit-shadow'
    }
  }
];

const report = buildPolicyReactionReport(events);
assert.equal(report.totals.tasks, 2);
assert.equal(report.totals.proposals, 3);
assert.equal(report.totals.observedBlocksOrEvidenceRequests, 2);
assert.equal(report.totals.enforcedBlocksOrEvidenceRequests, 1);
assert.equal(report.totals.shadowOrAdvisoryDisagreements, 1);
assert.equal(report.totals.riskElevations, 1);
assert.equal(report.totals.reactionsObserved, 1);
assert.equal(report.totals.unresolvedDecisions, 1);
assert.equal(report.reactions[0].nextAction, 'baseline');
assert.equal(report.reactions[0].reactionDelayMs, 1000);
assert.equal(report.counts.riskElevations['low->high'], 1);
assert.equal(report.counts.requestedEvidence.baseline, 1);
assert.equal(report.counts.requestedEvidence.review, 1);
assert.equal(report.counts.nextActionsAfterPolicyFeedback['needs_evidence->baseline'], 1);

const filtered = buildPolicyReactionReport(events, { taskId: 'task-a' });
assert.equal(filtered.totals.tasks, 1);
assert.equal(filtered.totals.proposals, 2);
assert.equal(filtered.totals.observedBlocksOrEvidenceRequests, 1);

const text = formatPolicyReactionReport(report);
assert.match(text, /Policy reaction report/);
assert.match(text, /low->high: 1/);
assert.match(text, /needs_evidence->baseline: 1/);
assert.match(text, /next=baseline/);

console.log('policy-report-tests: passed');
