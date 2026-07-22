import { executeAgentTask, resolvePoolName } from './execute-agent-task.mjs';
import { assertCanStartLoop, getCurrentDepth } from './recursion-guard.mjs';
import { loadPoolConfig, normalizePoolConfig, isModelCoolingDown } from '../lib/pool-normalizer.mjs';
import { runSmokeTest, filterResponsiveModels } from '../lib/smoke-test.mjs';
import { reapExpiredCooldowns, filterRetiredModels, loadRegistry } from '../lib/cooldown-manager.mjs';
import { BudgetTracker } from '../lib/budget-manager.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config/free-first-config.json');
const DEFAULT_POOLS_PATH = resolve(PACKAGE_ROOT, 'config/free-first-pools.json');
const DEFAULT_REGISTRY_PATH = resolve(PACKAGE_ROOT, 'config/model-registry.json');

function loadConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function updateProgress(pc, title, metadata) {
  if (!pc) return;
  try {
    pc({ title, metadata: { ...metadata, _t: Date.now() } });
    await yieldToEventLoop();
  } catch {}
}

const MODE_STEPS = {
  smoke:  { role: 'builder', agent: 'build-worker', label: 'smoke' },
  build:  { role: 'builder', agent: 'build-worker', label: 'build' },
  test:   { role: 'test', agent: 'test', label: 'test' },
  review: { role: 'reviewer', agent: 'review', label: 'review' },
  escalate: { role: 'escalation', agent: 'escalation', label: 'escalate' }
};

function summarizeWorkerOutput(result) {
  const stdout = result?.result?.stdout || '';
  const stderr = result?.result?.stderr || '';
  return `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean).slice(-30).join('\n').slice(0, 3000);
}

function classifyStep(label, result) {
  if (result.status !== 'completed') return 'failed';
  const text = summarizeWorkerOutput(result);
  if (label === 'test' && /RESULT:\s*(FAIL|BLOCKED)/i.test(text)) return 'failed';
  if (label === 'review' && /VERDICT:\s*(FAIL|BLOCKED)/i.test(text)) return 'failed';
  return 'passed';
}

export async function runAgentLoop({
  task,
  mode = 'build',
  maxRetries = 0,
  cwd = process.cwd(),
  parentSessionId,
  metadata = {},
  timeoutMs,
  signal,
  workerAdapter,
  env,
  taskId = `task-${Date.now()}`,
  progressCallback,
  forceModels
} = {}) {
  assertCanStartLoop({
    maxDepth: metadata.maxDepth ?? 1,
    agent: metadata.agent,
    env: metadata.env || process.env
  });
  if (typeof task !== 'string' || task.trim().length === 0) {
    return { status: 'failed', code: 'INVALID_INPUT', summary: 'task must be a non-empty string', requiresUserInput: true };
  }
  if (!MODE_STEPS[mode]) {
    return { status: 'failed', code: 'INVALID_INPUT', summary: `Unsupported mode "${mode}"`, requiresUserInput: true };
  }

  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const smokeTestEnabled = config?.general?.smoke_test_enabled !== false;
  const budgetTracker = BudgetTracker.fromFiles({
    taskId,
    step: 'smoke',
    configPath: DEFAULT_CONFIG_PATH,
    registryPath: DEFAULT_REGISTRY_PATH
  });
  const onSmokeUsage = ({ modelId, usage, reportedCostUsd }) => budgetTracker.recordUsage({
    modelId,
    usage,
    reportedCostUsd,
    step: 'smoke'
  });

  // --- Smoke test mode: test models and return results ---
  if (mode === 'smoke') {
    reapExpiredCooldowns();
    const poolConf = loadPoolConfig(DEFAULT_POOLS_PATH);
    const normalized = normalizePoolConfig(poolConf, { role: resolvePoolName('builder') });
    const registry = loadRegistry();
    const freeModels = [];
    for (const tier of ['freeCloud', 'openRouterFree', 'trialCreditModels']) {
      for (const modelId of normalized[tier] || []) {
        if (!isModelCoolingDown(normalized, modelId)) freeModels.push({ modelId, tier });
      }
    }
    // Filter out retired models so smoke tests don't waste call on them
    const activeModels = filterRetiredModels(freeModels.map(m => m.modelId), registry);
    const filteredModels = freeModels.filter(m => activeModels.includes(m.modelId));
    let smokeResults = null;
    if (filteredModels.length > 0) {
      await updateProgress(progressCallback, 'Smoke testing free models...', { models: filteredModels.length, status: 'smoke-test' });
      smokeResults = await runSmokeTest({
        models: filteredModels,
        providerTimeouts: config?.provider_timeouts_ms || {},
        smokeTestTimeoutMs: config?.general?.smoke_test_default_timeout_ms || 30000,
        smokeTestProviderTimeouts: config?.smoke_test_provider_timeout_ms || {},
        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback, onUsage: onSmokeUsage
      });
      await updateProgress(progressCallback, `Smoke test: ${smokeResults.responsive.length}/${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
    }
    if (smokeResults?.budgetExceeded || !budgetTracker.canContinue()) {
      const budget = budgetTracker.snapshot();
      return {
        status: 'failed', code: 'BUDGET_EXCEEDED', taskId,
        summary: budget.exceededReasons.join('; ') || 'Task budget exceeded during smoke test.',
        successfulModel: null, attemptedModels: [], changedFiles: [],
        smokeResults, budget,
        tests: { status: 'not-run', commands: [] }, review: { status: 'not-run' },
        requiresUserInput: false, logPath: '', steps: [{ step: 'smoke', status: 'failed', code: 'BUDGET_EXCEEDED', budget }]
      };
    }
    const hasResponsive = smokeResults && smokeResults.responsive.length > 0;
    return {
      status: hasResponsive ? 'completed' : 'failed',
      taskId, summary: hasResponsive ? `Smoke test: ${smokeResults.responsive.length} responsive models` : 'All providers unresponsive',
      successfulModel: null, attemptedModels: [], changedFiles: [],
      smokeResults: smokeResults ? { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive } : null,
      tests: { status: 'not-run', commands: [] }, review: { status: 'not-run' },
      requiresUserInput: !hasResponsive, logPath: '',
      budget: budgetTracker.snapshot(),
      steps: [{ step: 'smoke', status: hasResponsive ? 'completed' : 'failed', attemptedModels: (smokeResults?.responsive || []).map(r => r.modelId), smokeResults: { responsive: smokeResults?.responsive || [], unresponsive: smokeResults?.unresponsive || [] }, budget: budgetTracker.snapshot() }]
    };
  }

  // --- Regular mode: run smoke test if no forceModels provided ---
  let smokeResults = null;
  if (Array.isArray(forceModels) && forceModels.length > 0) {
    // forceModels from the caller are pre-filtered; trust caller
    smokeResults = { responsive: forceModels.map(id => ({ modelId: id })), unresponsive: [] };
  } else if (smokeTestEnabled) {
    reapExpiredCooldowns();
    const poolConf = loadPoolConfig(DEFAULT_POOLS_PATH);
    const firstPool = resolvePoolName(MODE_STEPS[mode].role);
    const normalized = normalizePoolConfig(poolConf, { role: firstPool });
    const registry = loadRegistry();
    const freeModels = [];
    for (const tier of ['freeCloud', 'openRouterFree', 'trialCreditModels']) {
      for (const modelId of normalized[tier] || []) {
        if (!isModelCoolingDown(normalized, modelId)) freeModels.push({ modelId, tier });
      }
    }
    // Filter out retired models
    const activeIds = filterRetiredModels(freeModels.map(m => m.modelId), registry);
    const filteredModels = freeModels.filter(m => activeIds.includes(m.modelId));
    if (filteredModels.length > 0) {
      await updateProgress(progressCallback, 'Smoke testing free models...', { models: filteredModels.length, status: 'smoke-test' });
      smokeResults = await runSmokeTest({
        models: filteredModels, providerTimeouts: config?.provider_timeouts_ms || {},
        smokeTestTimeoutMs: config?.general?.smoke_test_default_timeout_ms || 30000,
        smokeTestProviderTimeouts: config?.smoke_test_provider_timeout_ms || {},
        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback, onUsage: onSmokeUsage
      });
      await updateProgress(progressCallback, `Smoke test: ${smokeResults.responsive.length}/${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
    }
    if (smokeResults?.budgetExceeded || !budgetTracker.canContinue()) {
      const budget = budgetTracker.snapshot();
      return { status: 'failed', code: 'BUDGET_EXCEEDED', taskId, summary: budget.exceededReasons.join('; ') || 'Task budget exceeded during smoke test.', successfulModel: null, attemptedModels: [], changedFiles: [], smokeResults, budget, tests: { status: 'not-run', commands: [] }, review: { status: 'not-run' }, requiresUserInput: false, logPath: '', steps: [{ step: 'smoke', status: 'failed', code: 'BUDGET_EXCEEDED', budget }] };
    }
    if (smokeResults && smokeResults.responsive.length === 0 && smokeResults.unresponsive.length > 0) {
      await updateProgress(progressCallback, 'All providers unresponsive', { status: 'blocked' });
      return { status: 'failed', taskId, summary: 'All free providers are unresponsive.', successfulModel: null, attemptedModels: [], changedFiles: [], smokeResults: { responsive: [], unresponsive: smokeResults.unresponsive }, tests: { status: 'not-run', commands: [] }, review: { status: 'not-run' }, requiresUserInput: false, logPath: '', steps: [] };
    }
  }

  // --- Execute single step ---
  const step = MODE_STEPS[mode];
  const prompt = [
    `User request:\n${task}`, '', `Mode: ${mode}`, `Step: ${step.label}`, `Task ID: ${taskId}`, '',
    'Inspect the repository state before changing anything. Return a concise structured result with evidence. Do not call the agent_loop tool.'
  ].join('\n');

  await updateProgress(progressCallback, `${step.label} step...`, { step: step.label, status: 'running' });

  const executeOptions = {
    taskId: `${taskId}-${step.label}`, role: step.role, agent: step.agent, prompt,
    cwd, parentSessionId, metadata, timeoutMs, signal, workerAdapter,
    env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) },
    progressCallback,
    budgetTaskId: taskId,
    budgetStep: step.label,
    registryPath: DEFAULT_REGISTRY_PATH
  };
  if (smokeResults && smokeResults.responsive.length > 0) {
    // Filter smoke-responsive models through registry retirement check so
    // a model that is retired or disabled does not get passed as a candidate.
    const registry = loadRegistry();
    const responsiveIds = smokeResults.responsive.map(r => r.modelId);
    const activeIds = filterRetiredModels(responsiveIds, registry);
    executeOptions.forceModels = activeIds.length > 0 ? activeIds : responsiveIds;
  }

  const result = await executeAgentTask(executeOptions);
  const stepStatus = classifyStep(step.label, result);

  await updateProgress(progressCallback, `${step.label}: ${stepStatus}`, { step: step.label, status: stepStatus, attemptedModels: result.attemptedModels, successfulModel: result.successfulModel });

  return {
    status: stepStatus === 'passed' ? 'completed' : 'failed',
    code: result.code || null,
    taskId,
    summary: result.code === 'BUDGET_EXCEEDED'
      ? (result.budget?.exceededReasons?.join('; ') || 'Task budget exceeded.')
      : stepStatus === 'passed' ? `Agent loop completed (${step.label}).` : `${step.label} step did not pass.`,
    successfulModel: result.successfulModel || null,
    attemptedModels: result.attemptedModels || [],
    changedFiles: [],
    smokeResults: smokeResults ? { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive } : null,
    tests: { status: step.label === 'test' ? stepStatus : 'not-run', commands: [] },
    review: { status: step.label === 'review' ? stepStatus : 'not-run' },
    requiresUserInput: result.code === 'FREE_MODELS_EXHAUSTED',
    logPath: result.logPath || '',
    budget: result.budget || budgetTracker.snapshot(),
    steps: [{
      step: step.label, status: stepStatus,
      successfulModel: result.successfulModel,
      attemptedModels: result.attemptedModels,
      code: result.code, logPath: result.logPath,
      attemptDetails: result.attemptDetails || null,
      budget: result.budget || budgetTracker.snapshot(),
      smokeResults: smokeResults ? { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive } : null,
      stepStartedAt: new Date().toISOString()
    }]
  };
}
