function increment(target, key) {
  const normalized = String(key || 'unknown');
  target[normalized] = (target[normalized] || 0) + 1;
}

function toMillis(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedCounts(value) {
  return Object.fromEntries(
    Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

export function buildPolicyReactionReport(events = [], { taskId } = {}) {
  const selected = events
    .filter(event => !taskId || event.taskId === taskId)
    .filter(event => event.type === 'policy.proposed' || event.type === 'policy.decision')
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  const proposalsByTask = new Map();
  const pairs = [];
  const proposalCounts = {};
  const decisionCounts = {};
  const observedDecisionCounts = {};
  const nextActionCounts = {};
  const missingEvidenceCounts = {};
  const riskCounts = {};
  const inferredRiskCounts = {};
  const elevatedRiskCounts = {};

  for (const event of selected) {
    if (event.type === 'policy.proposed') {
      const proposal = {
        taskId: event.taskId,
        timestamp: event.timestamp,
        action: event.stage || 'unknown',
        proposedRisk: event.data?.proposedRisk || null,
        inferredRisk: event.data?.inferredRisk || null,
        effectiveRisk: event.data?.effectiveRisk || null,
        candidateHash: event.data?.candidateHash || null,
        riskReasons: event.data?.riskReasons || []
      };
      const queue = proposalsByTask.get(event.taskId) || [];
      queue.push(proposal);
      proposalsByTask.set(event.taskId, queue);
      increment(proposalCounts, proposal.action);
      increment(riskCounts, proposal.effectiveRisk);
      increment(inferredRiskCounts, proposal.inferredRisk);
      if (proposal.proposedRisk && proposal.effectiveRisk && proposal.proposedRisk !== proposal.effectiveRisk) {
        increment(elevatedRiskCounts, `${proposal.proposedRisk}->${proposal.effectiveRisk}`);
      }
      continue;
    }

    const queue = proposalsByTask.get(event.taskId) || [];
    const proposal = queue.shift() || {
      taskId: event.taskId,
      timestamp: event.timestamp,
      action: event.stage || 'unknown',
      proposedRisk: null,
      inferredRisk: null,
      effectiveRisk: null,
      candidateHash: null,
      riskReasons: []
    };
    proposalsByTask.set(event.taskId, queue);
    const pair = {
      ...proposal,
      decisionTimestamp: event.timestamp,
      mode: event.data?.mode || null,
      decision: event.data?.decision || 'unknown',
      observedDecision: event.data?.observedDecision || event.data?.decision || 'unknown',
      enforced: event.data?.enforced !== false,
      reasons: event.data?.reasons || [],
      missingEvidence: event.data?.missingEvidence || [],
      advisoryMissingEvidence: event.data?.advisoryMissingEvidence || [],
      permitId: event.data?.permitId || null,
      nextAction: null,
      nextActionTimestamp: null,
      reactionDelayMs: null
    };
    increment(decisionCounts, pair.decision);
    increment(observedDecisionCounts, pair.observedDecision);
    for (const item of [...pair.missingEvidence, ...pair.advisoryMissingEvidence]) {
      const category = String(item).split(':')[0].trim() || 'unknown';
      increment(missingEvidenceCounts, category);
    }
    pairs.push(pair);
  }

  const proposals = selected
    .filter(event => event.type === 'policy.proposed')
    .map(event => ({
      taskId: event.taskId,
      timestamp: event.timestamp,
      action: event.stage || 'unknown'
    }));

  for (const pair of pairs) {
    if (pair.decision === 'allow' && pair.observedDecision === 'allow') continue;
    const decisionAt = toMillis(pair.decisionTimestamp);
    const next = proposals.find(proposal => (
      proposal.taskId === pair.taskId
      && toMillis(proposal.timestamp) > decisionAt
    ));
    if (!next) continue;
    pair.nextAction = next.action;
    pair.nextActionTimestamp = next.timestamp;
    pair.reactionDelayMs = Math.max(0, toMillis(next.timestamp) - decisionAt);
    increment(nextActionCounts, `${pair.observedDecision}->${next.action}`);
  }

  const tasks = [...new Set(pairs.map(pair => pair.taskId))];
  const disagreements = pairs.filter(pair => pair.observedDecision !== 'allow');
  const unresolved = disagreements.filter(pair => !pair.nextAction);
  const reactionDelays = disagreements
    .map(pair => pair.reactionDelayMs)
    .filter(value => Number.isFinite(value));

  return {
    generatedAt: new Date().toISOString(),
    taskFilter: taskId || null,
    totals: {
      tasks: tasks.length,
      proposals: pairs.length,
      enforcedBlocksOrEvidenceRequests: pairs.filter(pair => pair.decision !== 'allow').length,
      observedBlocksOrEvidenceRequests: disagreements.length,
      shadowOrAdvisoryDisagreements: pairs.filter(pair => pair.decision === 'allow' && pair.observedDecision !== 'allow').length,
      riskElevations: pairs.filter(pair => pair.proposedRisk && pair.effectiveRisk && pair.proposedRisk !== pair.effectiveRisk).length,
      reactionsObserved: disagreements.length - unresolved.length,
      unresolvedDecisions: unresolved.length,
      medianReactionDelayMs: reactionDelays.length > 0
        ? [...reactionDelays].sort((a, b) => a - b)[Math.floor(reactionDelays.length / 2)]
        : null
    },
    counts: {
      proposedActions: sortedCounts(proposalCounts),
      decisions: sortedCounts(decisionCounts),
      observedDecisions: sortedCounts(observedDecisionCounts),
      effectiveRisk: sortedCounts(riskCounts),
      inferredRisk: sortedCounts(inferredRiskCounts),
      riskElevations: sortedCounts(elevatedRiskCounts),
      requestedEvidence: sortedCounts(missingEvidenceCounts),
      nextActionsAfterPolicyFeedback: sortedCounts(nextActionCounts)
    },
    reactions: disagreements.map(pair => ({
      taskId: pair.taskId,
      action: pair.action,
      mode: pair.mode,
      decision: pair.decision,
      observedDecision: pair.observedDecision,
      effectiveRisk: pair.effectiveRisk,
      reasons: pair.reasons,
      missingEvidence: pair.missingEvidence,
      advisoryMissingEvidence: pair.advisoryMissingEvidence,
      nextAction: pair.nextAction,
      reactionDelayMs: pair.reactionDelayMs,
      timestamp: pair.decisionTimestamp
    }))
  };
}

export function formatPolicyReactionReport(report) {
  const lines = [];
  lines.push('Policy reaction report');
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.taskFilter) lines.push(`Task: ${report.taskFilter}`);
  lines.push('');
  lines.push(`Tasks: ${report.totals.tasks}`);
  lines.push(`Proposals: ${report.totals.proposals}`);
  lines.push(`Observed blocks/evidence requests: ${report.totals.observedBlocksOrEvidenceRequests}`);
  lines.push(`Enforced blocks/evidence requests: ${report.totals.enforcedBlocksOrEvidenceRequests}`);
  lines.push(`Shadow/advisory disagreements: ${report.totals.shadowOrAdvisoryDisagreements}`);
  lines.push(`Risk elevations: ${report.totals.riskElevations}`);
  lines.push(`Reactions observed: ${report.totals.reactionsObserved}`);
  lines.push(`Unresolved decisions: ${report.totals.unresolvedDecisions}`);
  if (report.totals.medianReactionDelayMs !== null) {
    lines.push(`Median reaction delay: ${report.totals.medianReactionDelayMs} ms`);
  }

  const sections = [
    ['Proposed actions', report.counts.proposedActions],
    ['Decisions', report.counts.decisions],
    ['Observed decisions', report.counts.observedDecisions],
    ['Effective risk', report.counts.effectiveRisk],
    ['Risk elevations', report.counts.riskElevations],
    ['Requested evidence', report.counts.requestedEvidence],
    ['Next actions after policy feedback', report.counts.nextActionsAfterPolicyFeedback]
  ];
  for (const [title, counts] of sections) {
    lines.push('');
    lines.push(`${title}:`);
    const entries = Object.entries(counts);
    if (entries.length === 0) lines.push('  none');
    else for (const [key, count] of entries) lines.push(`  ${key}: ${count}`);
  }

  if (report.reactions.length > 0) {
    lines.push('');
    lines.push('Reaction timeline:');
    for (const item of report.reactions) {
      const requirements = [...item.reasons, ...item.missingEvidence, ...item.advisoryMissingEvidence];
      lines.push(`  ${item.timestamp} ${item.taskId} ${item.action} -> ${item.observedDecision}; next=${item.nextAction || 'none'}`);
      if (requirements.length > 0) lines.push(`    ${requirements.join(' | ')}`);
    }
  }
  return lines.join('\n');
}
