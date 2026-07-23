import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentLoopEventLogger, defaultEventLogPath, writeJsonAtomic } from './event-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
export const DEFAULT_POLICY_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config/orchestration-policy.json');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const ACTION_TO_MODE = Object.freeze({
  baseline: 'test',
  smoke: 'smoke',
  build: 'build',
  test: 'test',
  review: 'review',
  fix: 'build',
  escalate: 'escalate'
});
const PERMITTED_ACTIONS = new Set([
  'inspect',
  'request_approval',
  'record_approval',
  'record_evidence',
  'baseline',
  'skip_baseline',
  'smoke',
  'build',
  'test',
  'stage_candidate',
  'review',
  'fix',
  'escalate',
  'commit',
  'push',
  'ask_user',
  'replan',
  'stop'
]);
const TERMINAL_ALLOWED_ACTIONS = new Set(['record_evidence', 'ask_user', 'replan', 'stop']);
const EVIDENCE_TYPES = new Set([
  'approval',
  'baseline',
  'baseline_skip',
  'smoke',
  'build',
  'test',
  'integration_test',
  'validation',
  'candidate',
  'review',
  'rollback_plan',
  'isolation',
  'human_checkpoint',
  'push_approval',
  'budget',
  'commit',
  'note'
]);

function safeJson(path, fallback = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRisk(value, fallback = 'medium') {
  const normalized = String(value || '').toLowerCase();
  return RISK_LEVELS.includes(normalized) ? normalized : fallback;
}

function maxRisk(...values) {
  return values
    .map(value => normalizeRisk(value))
    .reduce((highest, value) => (
      RISK_LEVELS.indexOf(value) > RISK_LEVELS.indexOf(highest) ? value : highest
    ), 'low');
}

function compilePatterns(values = []) {
  return values.map(value => {
    try {
      return new RegExp(value, 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function matchesAny(value, patterns) {
  const text = String(value || '');
  return patterns.some(pattern => pattern.test(text));
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function docsOnly(paths = []) {
  return paths.length > 0 && paths.every(path => {
    const normalized = normalizePath(path).toLowerCase();
    return normalized.startsWith('docs/')
      || normalized.endsWith('.md')
      || normalized.endsWith('.mdx')
      || normalized === 'readme'
      || normalized.startsWith('readme.')
      || normalized === 'changelog.md'
      || normalized === 'license';
  });
}

function loadPolicyConfig(path = DEFAULT_POLICY_CONFIG_PATH) {
  const config = safeJson(path, {});
  const mode = process.env.AGENT_LOOP_POLICY_MODE || config.mode || 'risk';
  return {
    version: config.version || '1.0.0',
    mode: ['shadow', 'invariants', 'risk'].includes(mode) ? mode : 'risk',
    requireAgentLoopPermit: config.require_agent_loop_permit !== false,
    requirePolicyCommit: config.require_policy_commit !== false,
    permitTtlSeconds: Math.max(30, Number(config.permit_ttl_seconds) || 900),
    statePath: config.state_path || '.opencode/agent-loop-state/policy.json',
    taskTtlMinutes: Math.max(1, Number(config.task_ttl_minutes) || 1440),
    maxTrackedTasks: Math.max(1, Number(config.max_tracked_tasks) || 1000),
    maxFixCycles: Math.max(0, Number(config.max_fix_cycles) || 2),
    risk: {
      defaultLevel: normalizeRisk(config.risk?.default_level, 'medium'),
      docsOnlyLevel: normalizeRisk(config.risk?.docs_only_level, 'low'),
      highPathPatterns: compilePatterns(config.risk?.high_path_patterns),
      criticalPathPatterns: compilePatterns(config.risk?.critical_path_patterns),
      highKeywordPatterns: compilePatterns(config.risk?.high_keyword_patterns),
      criticalKeywordPatterns: compilePatterns(config.risk?.critical_keyword_patterns),
      recoveryKeywordPatterns: compilePatterns(config.risk?.recovery_keyword_patterns)
    },
    raw: config
  };
}

function statePath(cwd, config) {
  return process.env.AGENT_LOOP_POLICY_STATE_PATH || resolve(cwd, config.statePath);
}

function emptyStore() {
  return {
    schemaVersion: '1.0.0',
    updatedAt: nowIso(),
    tasks: {}
  };
}

function emptyTask(taskId) {
  const createdAt = nowIso();
  return {
    taskId,
    createdAt,
    updatedAt: createdAt,
    proposedRisk: null,
    inferredRisk: null,
    effectiveRisk: null,
    riskReasons: [],
    taskSummary: '',
    plannedPaths: [],
    terminalCode: null,
    approval: null,
    baseline: null,
    candidate: null,
    fixCycles: 0,
    evidence: [],
    actions: [],
    permits: {},
    lastCommit: null
  };
}

function pruneStore(store, config) {
  const cutoff = Date.now() - config.taskTtlMinutes * 60_000;
  const entries = Object.entries(store.tasks || {})
    .filter(([, task]) => toTimestamp(task.updatedAt) >= cutoff)
    .sort((a, b) => toTimestamp(b[1].updatedAt) - toTimestamp(a[1].updatedAt))
    .slice(0, config.maxTrackedTasks);
  store.tasks = Object.fromEntries(entries);
  store.updatedAt = nowIso();
  return store;
}

function truncate(value, max = 2000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeEvidence(input, source = 'agent') {
  if (!input || typeof input !== 'object') return null;
  const type = String(input.type || '').toLowerCase();
  if (!EVIDENCE_TYPES.has(type)) return null;
  const status = String(input.status || 'recorded').toLowerCase();
  return {
    id: randomUUID(),
    type,
    status,
    source,
    ref: truncate(input.ref || '', 512),
    candidateHash: input.candidateHash ? String(input.candidateHash) : null,
    details: input.details && typeof input.details === 'object' ? input.details : {},
    recordedAt: nowIso()
  };
}

function addEvidence(task, evidence, source = 'agent') {
  const items = Array.isArray(evidence) ? evidence : [];
  const added = [];
  for (const raw of items) {
    const item = normalizeEvidence(raw, source);
    if (!item) continue;
    task.evidence.push(item);
    added.push(item);
    if (item.type === 'approval') {
      task.approval = {
        status: item.status,
        ref: item.ref,
        recordedAt: item.recordedAt
      };
    }
    if (item.type === 'baseline' || item.type === 'baseline_skip') {
      task.baseline = {
        type: item.type,
        status: item.status,
        ref: item.ref,
        details: item.details,
        recordedAt: item.recordedAt
      };
    }
    if (item.type === 'budget' && item.status === 'exceeded') {
      task.terminalCode = 'BUDGET_EXCEEDED';
    }
    if (item.type === 'commit' && item.status === 'passed') {
      task.lastCommit = {
        hash: item.details?.commitHash || item.ref || null,
        candidateHash: item.candidateHash || null,
        recordedAt: item.recordedAt
      };
    }
  }
  task.evidence = task.evidence.slice(-300);
  return added;
}

function hasEvidence(task, type, statuses, { candidateHash, source } = {}) {
  const allowedStatuses = Array.isArray(statuses) ? statuses : [statuses];
  return task.evidence.some(item => (
    item.type === type
    && (!allowedStatuses[0] || allowedStatuses.includes(item.status))
    && (!candidateHash || item.candidateHash === candidateHash)
    && (!source || item.source === source)
  ));
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {
    if (allowFailure) return { ok: false, stdout: '', stderr: result.error.message, status: -1 };
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const error = new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
    error.code = 'GIT_COMMAND_FAILED';
    error.status = result.status;
    throw error;
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status
  };
}

export function computeStagedCandidate(cwd = process.cwd()) {
  const namesResult = runGit(cwd, ['diff', '--cached', '--name-only', '-z'], { allowFailure: true });
  if (!namesResult.ok) {
    return { available: false, hash: null, files: [], reason: namesResult.stderr.trim() || 'Not a Git repository' };
  }
  const files = namesResult.stdout.split('\0').filter(Boolean).map(normalizePath);
  if (files.length === 0) {
    return { available: true, hash: null, files: [], reason: 'No staged files' };
  }
  const diff = runGit(cwd, ['diff', '--cached', '--binary', '--no-ext-diff']).stdout;
  const hash = createHash('sha256').update(diff).digest('hex');
  return {
    available: true,
    hash: `sha256:${hash}`,
    files,
    reason: null
  };
}

function inferRisk({ proposedRisk, taskText, plannedPaths, config }) {
  const paths = [...new Set((plannedPaths || []).map(normalizePath).filter(Boolean))];
  const pathText = paths.join('\n');
  const combined = `${taskText || ''}\n${pathText}`;
  let inferred = config.risk.defaultLevel;
  const reasons = [];

  if (docsOnly(paths)) {
    inferred = config.risk.docsOnlyLevel;
    reasons.push('planned or staged paths are documentation-only');
  }
  if (matchesAny(pathText, config.risk.highPathPatterns) || matchesAny(taskText, config.risk.highKeywordPatterns)) {
    inferred = maxRisk(inferred, 'high');
    reasons.push('authentication, security, migration, deployment, or infrastructure risk signal');
  }
  if (matchesAny(pathText, config.risk.criticalPathPatterns) || matchesAny(taskText, config.risk.criticalKeywordPatterns)) {
    inferred = 'critical';
    reasons.push('payment, production, secret, or destructive-operation risk signal');
  }
  const effective = maxRisk(proposedRisk || config.risk.defaultLevel, inferred);
  const needsRecovery = matchesAny(combined, config.risk.recoveryKeywordPatterns)
    || effective === 'critical';

  return {
    proposed: normalizeRisk(proposedRisk, config.risk.defaultLevel),
    inferred,
    effective,
    reasons: [...new Set(reasons)],
    needsRecovery,
    docsOnly: docsOnly(paths)
  };
}

function decisionForIssues({ deny = [], missing = [] } = {}) {
  if (deny.length > 0) return { decision: 'deny', reasons: deny, missingEvidence: [] };
  if (missing.length > 0) return { decision: 'needs_evidence', reasons: [], missingEvidence: missing };
  return { decision: 'allow', reasons: [], missingEvidence: [] };
}

function applyMode(mode, invariantDecision, riskDecision) {
  const combined = decisionForIssues({
    deny: [...invariantDecision.reasons, ...riskDecision.reasons],
    missing: [...invariantDecision.missingEvidence, ...riskDecision.missingEvidence]
  });

  if (mode === 'shadow') {
    return {
      decision: 'allow',
      enforced: false,
      observedDecision: combined.decision,
      observedReasons: combined.reasons,
      advisoryMissingEvidence: combined.missingEvidence
    };
  }

  if (mode === 'invariants') {
    return {
      decision: invariantDecision.decision,
      enforced: true,
      observedDecision: combined.decision,
      observedReasons: combined.reasons,
      advisoryMissingEvidence: riskDecision.missingEvidence,
      reasons: invariantDecision.reasons,
      missingEvidence: invariantDecision.missingEvidence
    };
  }

  return {
    decision: combined.decision,
    enforced: true,
    observedDecision: combined.decision,
    observedReasons: combined.reasons,
    advisoryMissingEvidence: [],
    reasons: combined.reasons,
    missingEvidence: combined.missingEvidence
  };
}

function isDelegatedAction(action) {
  return Boolean(ACTION_TO_MODE[action]);
}

function validateTaskId(taskId) {
  return typeof taskId === 'string'
    && taskId.length >= 1
    && taskId.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId);
}

function invariantRequirements({ task, action, candidate, config, proposalEvidence }) {
  const deny = [];
  const missing = [];
  const delegatedOrIrreversible = isDelegatedAction(action) || ['stage_candidate', 'commit', 'push'].includes(action);

  if (task.terminalCode && delegatedOrIrreversible && !TERMINAL_ALLOWED_ACTIONS.has(action)) {
    deny.push(`Task is terminal with ${task.terminalCode}`);
  }

  if (['baseline', 'smoke', 'build', 'test', 'stage_candidate', 'review', 'fix', 'escalate', 'commit'].includes(action)) {
    if (!task.approval || task.approval.status !== 'granted') {
      missing.push('approval: explicit user approval for the implementation plan');
    }
  }

  if (action === 'record_approval') {
    const granted = proposalEvidence.some(item => item.type === 'approval' && item.status === 'granted');
    if (!granted) missing.push('approval evidence with status granted');
  }

  if (action === 'skip_baseline') {
    const justified = proposalEvidence.some(item => (
      item.type === 'baseline_skip'
      && ['justified', 'passed', 'recorded'].includes(item.status)
      && String(item.details?.justification || item.ref || '').trim().length >= 8
    ));
    if (!justified) missing.push('baseline_skip: a concrete justification');
  }

  if (action === 'stage_candidate') {
    if (!candidate.available) deny.push(candidate.reason || 'Unable to inspect staged candidate');
    else if (!candidate.hash || candidate.files.length === 0) missing.push('candidate: stage at least one intended file');
  }

  if (action === 'review') {
    if (!candidate.hash || candidate.files.length === 0) missing.push('candidate: a non-empty staged candidate');
  }

  if (action === 'fix' && task.fixCycles >= config.maxFixCycles) {
    deny.push(`Maximum fix cycles reached (${config.maxFixCycles})`);
  }

  if (action === 'commit') {
    if (!candidate.hash || candidate.files.length === 0) {
      missing.push('candidate: a non-empty staged candidate');
    } else {
      if (!task.candidate || task.candidate.hash !== candidate.hash) {
        missing.push('candidate: re-authorize the current staged candidate');
      }
      if (!hasEvidence(task, 'review', 'passed', { candidateHash: candidate.hash, source: 'runtime' })) {
        missing.push('review: runtime PASS for the current staged candidate');
      }
    }
  }

  if (action === 'push' && !hasEvidence(task, 'push_approval', 'granted')) {
    missing.push('push_approval: explicit user authorization to push');
  }

  return decisionForIssues({ deny, missing });
}

function riskRequirements({ task, action, risk, candidate }) {
  const deny = [];
  const missing = [];
  const level = risk.effective;
  const candidateHash = candidate.hash || task.candidate?.hash || null;
  const baselinePassed = hasEvidence(task, 'baseline', ['passed', 'reproduced'], { source: 'runtime' })
    || hasEvidence(task, 'baseline', ['passed', 'reproduced']);
  const baselineSkipped = hasEvidence(task, 'baseline_skip', ['justified', 'passed', 'recorded']);
  const currentTestPassed = candidateHash
    ? hasEvidence(task, 'test', 'passed', { candidateHash, source: 'runtime' })
    : false;
  const currentReviewPassed = candidateHash
    ? hasEvidence(task, 'review', 'passed', { candidateHash, source: 'runtime' })
    : false;
  const currentValidation = candidateHash
    ? hasEvidence(task, 'validation', 'passed', { candidateHash })
    : hasEvidence(task, 'validation', 'passed');
  const currentIntegration = candidateHash
    ? hasEvidence(task, 'integration_test', 'passed', { candidateHash })
    : hasEvidence(task, 'integration_test', 'passed');

  if (action === 'skip_baseline' && ['high', 'critical'].includes(level)) {
    deny.push(`${level}-risk work cannot skip baseline evidence`);
  }

  if (['build', 'fix'].includes(action)) {
    if (level === 'medium' && !baselinePassed && !baselineSkipped) {
      missing.push('baseline: run it or record a justified skip');
    }
    if (['high', 'critical'].includes(level) && !baselinePassed) {
      missing.push('baseline: runtime baseline evidence is required for high-risk work');
    }
  }

  if (action === 'commit') {
    if (!currentReviewPassed) {
      missing.push('review: PASS bound to the current candidate');
    }
    if (level === 'low') {
      if (!currentValidation && !currentTestPassed) {
        missing.push('validation: documentation/link validation or a test PASS bound to the current candidate');
      }
    }
    if (level === 'medium') {
      if (!baselinePassed && !baselineSkipped) {
        missing.push('baseline: run it or record a justified skip');
      }
      if (!currentTestPassed) {
        missing.push('test: focused runtime PASS bound to the current candidate');
      }
    }
    if (['high', 'critical'].includes(level)) {
      if (!baselinePassed) missing.push('baseline: runtime baseline evidence');
      if (!currentTestPassed) missing.push('test: runtime PASS bound to the current candidate');
      if (!currentIntegration) missing.push('integration_test: representative integration or end-to-end evidence bound to the current candidate');
      if (risk.needsRecovery && !hasEvidence(task, 'rollback_plan', ['passed', 'recorded'])) {
        missing.push('rollback_plan: recovery or forward-fix plan');
      }
    }
    if (level === 'critical') {
      if (!hasEvidence(task, 'isolation', ['passed', 'recorded'])) {
        missing.push('isolation: container, VM, worktree, or equivalent isolation evidence');
      }
      if (!hasEvidence(task, 'human_checkpoint', 'granted')) {
        missing.push('human_checkpoint: explicit approval after final evidence');
      }
    }
  }

  return decisionForIssues({ deny, missing });
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    proposedRisk: task.proposedRisk,
    inferredRisk: task.inferredRisk,
    effectiveRisk: task.effectiveRisk,
    riskReasons: task.riskReasons,
    terminalCode: task.terminalCode,
    approval: task.approval,
    baseline: task.baseline,
    candidate: task.candidate,
    fixCycles: task.fixCycles,
    evidence: task.evidence.slice(-40),
    actions: task.actions.slice(-40),
    pendingPermits: Object.values(task.permits).filter(permit => !permit.consumedAt && !permit.revokedAt),
    lastCommit: task.lastCommit
  };
}

export class OrchestrationPolicyKernel {
  constructor({
    cwd = process.cwd(),
    configPath = DEFAULT_POLICY_CONFIG_PATH,
    config,
    eventLogPath
  } = {}) {
    this.cwd = resolve(cwd);
    const loaded = loadPolicyConfig(configPath);
    this.config = config ? {
      ...loaded,
      ...config,
      risk: { ...loaded.risk, ...(config.risk || {}) }
    } : loaded;
    this.path = statePath(this.cwd, this.config);
    this.store = pruneStore(safeJson(this.path, emptyStore()), this.config);
    this.eventLogPath = eventLogPath || defaultEventLogPath(this.cwd);
  }

  getTask(taskId) {
    this.store.tasks ||= {};
    this.store.tasks[taskId] ||= emptyTask(taskId);
    return this.store.tasks[taskId];
  }

  save() {
    pruneStore(this.store, this.config);
    writeJsonAtomic(this.path, this.store);
  }

  logger(taskId) {
    return new AgentLoopEventLogger({
      taskId,
      cwd: this.cwd,
      path: this.eventLogPath,
      enabled: true
    });
  }

  snapshot(taskId) {
    const task = this.getTask(taskId);
    return {
      mode: this.config.mode,
      statePath: this.path,
      requireAgentLoopPermit: this.config.requireAgentLoopPermit,
      requirePolicyCommit: this.config.requirePolicyCommit,
      task: publicTask(task)
    };
  }

  propose({
    taskId,
    action,
    reason = '',
    task = '',
    riskLevel,
    riskReasons = [],
    plannedPaths = [],
    evidence = []
  } = {}) {
    if (!validateTaskId(taskId)) {
      return {
        decision: 'deny',
        enforced: true,
        code: 'INVALID_TASK_ID',
        reasons: ['taskId must be 1-128 characters and contain only letters, numbers, dot, underscore, colon, or dash']
      };
    }
    if (!PERMITTED_ACTIONS.has(action)) {
      return {
        decision: 'deny',
        enforced: true,
        code: 'INVALID_POLICY_ACTION',
        reasons: [`Unsupported policy action: ${action}`]
      };
    }

    const taskState = this.getTask(taskId);
    const proposalEvidence = addEvidence(taskState, evidence, 'agent');
    if (task) taskState.taskSummary = truncate(task, 4000);
    if (plannedPaths.length > 0) {
      taskState.plannedPaths = [...new Set([...taskState.plannedPaths, ...plannedPaths.map(normalizePath)])].slice(0, 500);
    }

    const candidate = computeStagedCandidate(this.cwd);
    const riskPaths = [...new Set([
      ...taskState.plannedPaths,
      ...(candidate.files || [])
    ])];
    const risk = inferRisk({
      proposedRisk: riskLevel || taskState.proposedRisk || this.config.risk.defaultLevel,
      taskText: task || taskState.taskSummary || reason,
      plannedPaths: riskPaths,
      config: this.config
    });
    taskState.proposedRisk = risk.proposed;
    taskState.inferredRisk = risk.inferred;
    taskState.effectiveRisk = risk.effective;
    taskState.riskReasons = [...new Set([
      ...taskState.riskReasons,
      ...risk.reasons,
      ...(riskReasons || []).map(value => truncate(value, 300))
    ])].slice(0, 100);

    if (action === 'stage_candidate' && candidate.hash) {
      taskState.candidate = {
        hash: candidate.hash,
        files: candidate.files,
        authorizedAt: nowIso()
      };
      addEvidence(taskState, [{
        type: 'candidate',
        status: 'recorded',
        ref: 'git staged diff',
        candidateHash: candidate.hash,
        details: { files: candidate.files }
      }], 'runtime');
    }

    const invariantDecision = invariantRequirements({
      task: taskState,
      action,
      candidate,
      config: this.config,
      proposalEvidence
    });
    const riskDecision = riskRequirements({
      task: taskState,
      action,
      risk,
      candidate
    });
    const applied = applyMode(this.config.mode, invariantDecision, riskDecision);

    let permit = null;
    if (applied.decision === 'allow' && (isDelegatedAction(action) || action === 'commit')) {
      permit = {
        id: randomUUID(),
        taskId,
        action,
        mode: ACTION_TO_MODE[action] || null,
        candidateHash: candidate.hash || taskState.candidate?.hash || null,
        issuedAt: nowIso(),
        expiresAt: new Date(Date.now() + this.config.permitTtlSeconds * 1000).toISOString(),
        consumedAt: null,
        revokedAt: null
      };
      taskState.permits[permit.id] = permit;
    }

    const entry = {
      id: randomUUID(),
      action,
      reason: truncate(reason, 2000),
      decision: applied.decision,
      observedDecision: applied.observedDecision,
      enforced: applied.enforced,
      effectiveRisk: risk.effective,
      candidateHash: candidate.hash || taskState.candidate?.hash || null,
      permitId: permit?.id || null,
      createdAt: nowIso()
    };
    taskState.actions.push(entry);
    taskState.actions = taskState.actions.slice(-300);
    taskState.updatedAt = nowIso();
    this.save();

    const logger = this.logger(taskId);
    logger.emit('policy.proposed', {
      stage: action,
      data: {
        reason,
        proposedRisk: risk.proposed,
        inferredRisk: risk.inferred,
        effectiveRisk: risk.effective,
        riskReasons: taskState.riskReasons,
        candidateHash: entry.candidateHash
      }
    });
    logger.emit('policy.decision', {
      stage: action,
      data: {
        mode: this.config.mode,
        decision: applied.decision,
        observedDecision: applied.observedDecision,
        enforced: applied.enforced,
        reasons: applied.reasons || [],
        missingEvidence: applied.missingEvidence || [],
        advisoryMissingEvidence: applied.advisoryMissingEvidence || [],
        permitId: permit?.id || null
      }
    });

    return {
      code: applied.decision === 'allow'
        ? 'POLICY_ALLOWED'
        : applied.decision === 'needs_evidence'
          ? 'POLICY_NEEDS_EVIDENCE'
          : 'POLICY_DENIED',
      mode: this.config.mode,
      decision: applied.decision,
      enforced: applied.enforced,
      observedDecision: applied.observedDecision,
      reasons: applied.reasons || [],
      missingEvidence: applied.missingEvidence || [],
      advisoryMissingEvidence: applied.advisoryMissingEvidence || [],
      effectiveRisk: risk.effective,
      inferredRisk: risk.inferred,
      riskReasons: taskState.riskReasons,
      permit: permit ? {
        id: permit.id,
        action: permit.action,
        mode: permit.mode,
        candidateHash: permit.candidateHash,
        expiresAt: permit.expiresAt
      } : null,
      state: publicTask(taskState)
    };
  }

  consumePermit({ taskId, permitId, mode, action } = {}) {
    if (!validateTaskId(taskId)) {
      const error = new Error('A valid taskId is required');
      error.code = 'INVALID_TASK_ID';
      throw error;
    }
    if (!permitId) {
      const error = new Error('A policy permit is required');
      error.code = 'POLICY_PERMIT_REQUIRED';
      throw error;
    }
    const task = this.getTask(taskId);
    const permit = task.permits?.[permitId];
    if (!permit) {
      const error = new Error('Policy permit was not found for this task');
      error.code = 'POLICY_PERMIT_INVALID';
      throw error;
    }
    if (permit.consumedAt) {
      const error = new Error('Policy permit has already been consumed');
      error.code = 'POLICY_PERMIT_CONSUMED';
      throw error;
    }
    if (permit.revokedAt || toTimestamp(permit.expiresAt) <= Date.now()) {
      const error = new Error('Policy permit is expired or revoked');
      error.code = 'POLICY_PERMIT_EXPIRED';
      throw error;
    }
    if (mode && permit.mode !== mode) {
      const error = new Error(`Policy permit authorizes mode ${permit.mode}, not ${mode}`);
      error.code = 'POLICY_PERMIT_MODE_MISMATCH';
      throw error;
    }
    if (action && permit.action !== action) {
      const error = new Error(`Policy permit authorizes action ${permit.action}, not ${action}`);
      error.code = 'POLICY_PERMIT_ACTION_MISMATCH';
      throw error;
    }

    if (permit.action === 'commit') {
      const candidate = computeStagedCandidate(this.cwd);
      if (!candidate.hash || candidate.hash !== permit.candidateHash) {
        const error = new Error('The staged candidate changed after commit authorization');
        error.code = 'POLICY_CANDIDATE_CHANGED';
        throw error;
      }
    }

    permit.consumedAt = nowIso();
    if (permit.action === 'fix') task.fixCycles += 1;
    task.updatedAt = nowIso();
    this.save();
    this.logger(taskId).emit('policy.permit-consumed', {
      stage: permit.action,
      data: {
        permitId,
        mode: permit.mode,
        candidateHash: permit.candidateHash
      }
    });
    return { ...permit };
  }

  recordAgentLoopResult({ taskId, permitId, mode, result } = {}) {
    const task = this.getTask(taskId);
    const permit = task.permits?.[permitId];
    if (!permit) return this.snapshot(taskId);

    const completed = result?.status === 'completed';
    const status = completed ? 'passed' : result?.status === 'blocked' ? 'blocked' : 'failed';
    const evidenceType = permit.action === 'baseline'
      ? 'baseline'
      : permit.action === 'fix'
        ? 'build'
        : permit.action;
    const specializedStatus = evidenceType === 'baseline' && completed
      ? (result?.tests?.status === 'failed' ? 'reproduced' : 'passed')
      : status;

    addEvidence(task, [{
      type: EVIDENCE_TYPES.has(evidenceType) ? evidenceType : 'note',
      status: specializedStatus,
      ref: result?.eventLogPath || result?.logPath || `agent_loop:${mode}`,
      candidateHash: permit.candidateHash || null,
      details: {
        code: result?.code || null,
        successfulModel: result?.successfulModel || null,
        attemptedModels: result?.attemptedModels || [],
        summary: result?.summary || ''
      }
    }], 'runtime');

    if (result?.code === 'BUDGET_EXCEEDED' || result?.budget?.exceeded === true) {
      task.terminalCode = 'BUDGET_EXCEEDED';
      addEvidence(task, [{
        type: 'budget',
        status: 'exceeded',
        ref: result?.eventLogPath || result?.logPath || 'agent_loop',
        details: { budget: result?.budget || null }
      }], 'runtime');
    }

    task.updatedAt = nowIso();
    this.save();
    this.logger(taskId).emit('policy.execution-recorded', {
      stage: permit.action,
      data: {
        permitId,
        mode,
        status: specializedStatus,
        code: result?.code || null,
        candidateHash: permit.candidateHash || null
      }
    });
    return this.snapshot(taskId);
  }

  commit({ taskId, permitId, message } = {}) {
    if (!this.config.requirePolicyCommit) {
      const error = new Error('Policy-controlled commit is disabled');
      error.code = 'POLICY_COMMIT_DISABLED';
      throw error;
    }
    const commitMessage = String(message || '').trim();
    if (!commitMessage || commitMessage.length > 500) {
      const error = new Error('Commit message must be between 1 and 500 characters');
      error.code = 'INVALID_COMMIT_MESSAGE';
      throw error;
    }
    const permit = this.consumePermit({ taskId, permitId, action: 'commit' });
    const result = runGit(this.cwd, ['commit', '-m', commitMessage], { allowFailure: true });
    if (!result.ok) {
      const error = new Error((result.stderr || result.stdout || 'git commit failed').trim());
      error.code = 'POLICY_COMMIT_FAILED';
      throw error;
    }
    const commitHash = runGit(this.cwd, ['rev-parse', 'HEAD']).stdout.trim();
    const task = this.getTask(taskId);
    addEvidence(task, [{
      type: 'commit',
      status: 'passed',
      ref: commitHash,
      candidateHash: permit.candidateHash,
      details: { commitHash, message: commitMessage }
    }], 'runtime');
    task.updatedAt = nowIso();
    this.save();
    this.logger(taskId).emit('policy.commit-completed', {
      stage: 'commit',
      data: {
        permitId,
        commitHash,
        candidateHash: permit.candidateHash
      }
    });
    return {
      status: 'completed',
      code: 'POLICY_COMMIT_COMPLETED',
      taskId,
      commitHash,
      candidateHash: permit.candidateHash,
      stdout: result.stdout.trim()
    };
  }
}

export function loadOrchestrationPolicyConfig(path = DEFAULT_POLICY_CONFIG_PATH) {
  return loadPolicyConfig(path);
}
