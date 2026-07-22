import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FailoverHandler } from '../lib/failover-handler.mjs';
import { PaidFallbackController } from '../lib/paid-fallback.mjs';
import { loadPoolConfig, normalizePoolConfig, isModelCoolingDown } from '../lib/pool-normalizer.mjs';
import { runOpenCodeWorker, resolveTimeoutMs } from './opencode-worker-runner.mjs';
import { reapExpiredCooldowns } from '../lib/cooldown-manager.mjs';
import { BudgetTracker } from '../lib/budget-manager.mjs';
import { AgentLoopEventLogger, redactSensitive } from '../lib/event-log.mjs';
import { resolveProviderAdapter } from '../lib/provider-adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const DEFAULT_LOG_DIR = resolve(PACKAGE_ROOT, '.opencode', 'agent-loop-logs');
const DEFAULT_REGISTRY_PATH = resolve(PACKAGE_ROOT, 'config/model-registry.json');

function loadFreeFirstConfig(configPath) {
  try { return JSON.parse(readFileSync(configPath, 'utf-8')); }
  catch { return {}; }
}

function extractProviderTimeoutConfig(config) {
  return {
    providerTimeouts: config?.provider_timeouts_ms || {},
    latencyTimeoutMapping: config?.latency_timeout_mapping || {}
  };
}

const ROLE_POOL = {
  build: 'routine-builder',
  builder: 'routine-builder',
  'complex-builder': 'complex-builder',
  complex: 'complex-builder',
  'routine-builder': 'routine-builder',
  routine: 'routine-builder',
  'local-trivial-builder': 'local-trivial-builder',
  'local-trivial': 'local-trivial-builder',
  'test-runner': 'test-runner',
  test: 'test-fixer',
  tester: 'test-fixer',
  'test-fixer': 'test-fixer',
  review: 'reviewer',
  reviewer: 'reviewer',
  orchestrator: 'orchestrator',
  explore: 'explore',
  utility: 'utility',
  reconcile: 'routine-builder',
  escalation: 'escalation'
};

export function resolvePoolName(role) {
  return ROLE_POOL[role] || role;
}

function tieredModels(normalized) {
  const rows = [];
  for (const tier of ['freeCloud', 'openRouterFree', 'trialCreditModels', 'paidCloud']) {
    for (const modelId of normalized[tier] || []) {
      if (!isModelCoolingDown(normalized, modelId)) rows.push({ modelId, tier });
    }
  }
  return rows;
}

function redact(text) {
  return String(redactSensitive(String(text || ''))).slice(0, 4000);
}

function writeAttemptLog(logPath, event) {
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...redactSensitive(event) })}\n`, 'utf8');
}

function eventTypeForRouting(type) {
  const map = {
    'attempt-start': 'model.attempt.started',
    'attempt-success': 'model.attempt.completed',
    'attempt-retryable-failure': 'model.attempt.failed',
    'attempt-task-failure': 'stage.task-failed',
    'provider-wide-failure': 'provider.cooldown',
    'skip-provider-cooldown': 'provider.skipped',
    'budget-denied': 'budget.exceeded',
    'budget-exceeded': 'budget.exceeded',
    'paid-denied': 'paid-fallback.denied',
    'cooldown-reap': 'provider.cooldown-reaped'
  };
  return map[type] || 'routing.event';
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    if (signal) {
      const abort = () => {
        clearTimeout(timer);
        const error = new Error('Retry wait cancelled');
        error.code = 'USER_CANCELLED';
        reject(error);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function executeAgentTask({
  taskId = `task-${Date.now()}`,
  role,
  agent,
  prompt,
  cwd = process.cwd(),
  parentSessionId,
  metadata = {},
  timeoutMs,
  env = {},
  signal,
  workerAdapter = runOpenCodeWorker,
  configPath = resolve(PACKAGE_ROOT, 'config/free-first-config.json'),
  poolsPath = resolve(PACKAGE_ROOT, 'config/free-first-pools.json'),
  registryPath = DEFAULT_REGISTRY_PATH,
  logDir = DEFAULT_LOG_DIR,
  forceModels,
  progressCallback,
  budgetTaskId = taskId,
  budgetStep = role,
  maxRetries,
  eventLogger
}) {
  if (!role) throw new Error('executeAgentTask requires role');
  if (!agent) throw new Error('executeAgentTask requires agent');
  if (!prompt) throw new Error('executeAgentTask requires prompt');

  const events = eventLogger || new AgentLoopEventLogger({ taskId: budgetTaskId, cwd });
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, `${taskId}-${role}.jsonl`);
  writeFileSync(logPath, '', 'utf8');

  reapExpiredCooldowns();
  const poolName = resolvePoolName(role);
  const poolConfig = loadPoolConfig(poolsPath);
  const normalized = normalizePoolConfig(poolConfig, { role: poolName });
  let models = tieredModels(normalized);

  if (Array.isArray(forceModels) && forceModels.length > 0) {
    const forceSet = new Set(forceModels);
    models = models.filter(model => forceSet.has(model.modelId));
    if (models.length === 0) {
      events.emit('stage.blocked', { stage: budgetStep, role, data: { code: 'ALL_MODELS_FAILED', reason: 'Smoke-responsive models were filtered out.' } });
      return {
        status: 'failed', code: 'ALL_MODELS_FAILED', taskId, role, agent, poolName,
        attemptedModels: [], successfulModel: null, attemptDetails: [],
        stepStartedAt: new Date().toISOString(), logPath,
        summary: 'All responsive models from smoke test were filtered out before work began.'
      };
    }
  }

  const freeFirstConfig = loadFreeFirstConfig(configPath);
  const configuredRetryLimit = Number.isInteger(freeFirstConfig?.retry?.max_retries)
    ? freeFirstConfig.retry.max_retries
    : 0;
  const retryLimit = Number.isInteger(maxRetries)
    ? Math.max(0, Math.min(maxRetries, 5))
    : Math.max(0, Math.min(configuredRetryLimit, 5));
  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);
  const budgetTracker = BudgetTracker.fromFiles({
    taskId: budgetTaskId,
    step: budgetStep,
    configPath,
    registryPath,
    cwd
  });

  const failover = new FailoverHandler(configPath, poolsPath);
  await failover.loadConfig();
  await failover.loadPools();
  const paidFallback = new PaidFallbackController(configPath);
  const attemptDetails = [];
  const stepStartedAt = new Date().toISOString();
  events.emit('stage.started', { stage: budgetStep, role, data: { agent, poolName, retryLimit, candidateModels: models.map(model => model.modelId) } });

  const result = await failover.runWithFailover({
    taskId,
    role: poolName,
    poolName,
    models,
    paidFallback,
    paidApproved: metadata.paidApproved === true || process.env.AGENT_LOOP_PAID_APPROVED === '1',
    log: event => {
      writeAttemptLog(logPath, event);
      events.emit(eventTypeForRouting(event.type), {
        stage: budgetStep,
        role,
        modelId: event.modelId,
        data: { ...event, type: undefined }
      });
    },
    canAttempt: async () => {
      const budget = budgetTracker.snapshot();
      return budgetTracker.canContinue()
        ? { allowed: true, budget }
        : { allowed: false, code: 'BUDGET_EXCEEDED', reason: budget.exceededReasons.join('; '), budget };
    },
    invoke: async ({ modelId, tier, attemptIndex, attempts }) => {
      const checkpoint = attempts.length > 0
        ? `\n\nPrevious provider attempts failed. Before editing, inspect repository state and git diff. Attempted models: ${attempts.map(item => item.modelId).join(', ')}.`
        : '';
      const workerPrompt = `${prompt}${checkpoint}`;
      const modelLabel = modelId.split('/').pop();
      let finalInvocation = null;
      const providerAdapter = resolveProviderAdapter(modelId);
      const providerPolicy = freeFirstConfig?.provider_retry?.[providerAdapter.id] || {};
      const adapterRetryPolicy = providerAdapter.retryPolicy(freeFirstConfig.retry || {}, providerPolicy);
      const modelRetryLimit = Number.isInteger(adapterRetryPolicy.maxRetries)
        ? Math.min(retryLimit, Math.max(0, adapterRetryPolicy.maxRetries))
        : retryLimit;

      for (let retryIndex = 0; retryIndex <= modelRetryLimit; retryIndex += 1) {
        if (!budgetTracker.canContinue()) {
          const budget = budgetTracker.snapshot();
          return { success: false, code: 'BUDGET_EXCEEDED', budgetExceeded: true, budget };
        }

        const suffix = retryIndex > 0 ? `-retry-${retryIndex}` : '';
        const attemptLog = resolve(logDir, `${taskId}-${role}-attempt-${attemptIndex + 1}${suffix}.log`);
        const progressLogPath = resolve(logDir, `${taskId}-${role}-attempt-${attemptIndex + 1}${suffix}-progress.jsonl`);
        const attemptStartedAt = new Date().toISOString();
        const effectiveTimeoutMs = resolveTimeoutMs({ model: modelId, timeoutMs, providerTimeouts, latencyTimeoutMapping });
        events.emit('model.invocation.started', { stage: budgetStep, role, modelId, data: { tier, attemptIndex, retryIndex, timeoutMs: effectiveTimeoutMs } });

        if (progressCallback) {
          progressCallback({ title: `Trying ${modelLabel}${retryIndex ? ` retry ${retryIndex}` : ''}...`, metadata: { model: modelId, tier, action: 'starting', attempt: attemptIndex + 1, retry: retryIndex, timeoutMs: effectiveTimeoutMs } });
          await new Promise(resolvePromise => setImmediate(resolvePromise));
        }

        const stdoutTailCallback = tail => {
          if (progressCallback) progressCallback({ title: modelLabel, metadata: { model: modelId, tail, action: 'progress', attempt: attemptIndex + 1, retry: retryIndex } });
        };
        let usageRecordedIncrementally = false;
        const invocation = await workerAdapter({
          cwd,
          agent,
          model: modelId,
          prompt: workerPrompt,
          timeoutMs: effectiveTimeoutMs,
          env: {
            ...env,
            AGENT_LOOP_PARENT_SESSION: parentSessionId || '',
            AGENT_LOOP_TASK_ID: budgetTaskId,
            AGENT_LOOP_ROLE: role,
            AGENT_LOOP_MODEL: modelId,
            AGENT_LOOP_WORKER_EXECUTABLE: process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode'
          },
          signal,
          title: taskId,
          progressLogPath,
          providerTimeouts,
          latencyTimeoutMapping,
          stdoutTailCallback,
          onUsage: ({ usage, reportedCostUsd }) => {
            usageRecordedIncrementally = true;
            const budget = budgetTracker.recordUsage({ modelId, usage, reportedCostUsd, step: budgetStep });
            writeAttemptLog(logPath, { type: 'budget-usage', taskId: budgetTaskId, step: budgetStep, modelId, usage, budget });
            events.emit(budget.exceeded ? 'budget.exceeded' : 'budget.updated', { stage: budgetStep, role, modelId, data: { usage, budget } });
            if (progressCallback) progressCallback({ title: `Budget: ${budget.used.total} tokens / $${budget.used.billableCostUsd.toFixed(4)}`, metadata: { action: 'budget', budget } });
            return budget;
          }
        });

        if (!usageRecordedIncrementally && invocation?.usage) {
          invocation.budget = budgetTracker.recordUsage({ modelId, usage: invocation.usage, reportedCostUsd: invocation.reportedCostUsd, step: budgetStep });
        }
        const budget = budgetTracker.snapshot();
        if (budget.exceeded) {
          invocation.success = false;
          invocation.code = 'BUDGET_EXCEEDED';
          invocation.budgetExceeded = true;
          invocation.budget = budget;
        }

        writeFileSync(attemptLog, [
          `model=${modelId}`,
          `tier=${tier}`,
          `retryIndex=${retryIndex}`,
          `timeoutMs=${effectiveTimeoutMs}`,
          `exitCode=${invocation.exitCode ?? ''}`,
          `usage=${JSON.stringify(invocation.usage || {})}`,
          `reportedCostUsd=${invocation.reportedCostUsd || 0}`,
          `budgetExceeded=${invocation.budgetExceeded === true}`,
          '--- stdout ---', redact(invocation.stdout),
          '--- stderr ---', redact(invocation.stderr)
        ].join('\n'), 'utf8');

        const detail = {
          modelId, tier, attemptIndex: attemptIndex + 1, retryIndex,
          startedAt: attemptStartedAt, finishedAt: new Date().toISOString(),
          timedOut: Boolean(invocation.timedOut),
          lastActivityAt: invocation.lastActivityAt ? new Date(invocation.lastActivityAt).toISOString() : null,
          exitCode: invocation.exitCode, success: Boolean(invocation.success), code: invocation.code || null,
          usage: invocation.usage || null, reportedCostUsd: invocation.reportedCostUsd || 0,
          budgetExceeded: invocation.budgetExceeded === true,
          budget: invocation.budget || budgetTracker.snapshot(), attemptLog, progressLogPath
        };
        attemptDetails.push(detail);
        events.emit(invocation.success ? 'model.invocation.completed' : 'model.invocation.failed', { stage: budgetStep, role, modelId, data: detail });
        finalInvocation = invocation;

        if (invocation.success || invocation.budgetExceeded || invocation.code === 'BUDGET_EXCEEDED') break;
        const classification = failover.classifyFailure(invocation);
        const adapterDecision = providerAdapter.shouldRetry(invocation, freeFirstConfig.retry || {}, providerPolicy);
        const retryable = adapterDecision ?? classification.retryable;
        if (!retryable || retryIndex >= modelRetryLimit) break;
        const delayMs = failover.getBackoffDelay(retryIndex);
        events.emit('model.retry.scheduled', { stage: budgetStep, role, modelId, data: { retryIndex: retryIndex + 1, delayMs, reason: classification.reason } });
        await sleep(delayMs, signal);
      }

      const status = finalInvocation?.success ? 'ok' : finalInvocation?.timedOut ? 'timeout' : 'failed';
      if (progressCallback) {
        progressCallback({ title: `${modelLabel}: ${status}${finalInvocation?.code ? ` (${finalInvocation.code})` : ''}`, metadata: { model: modelId, action: 'result', status, code: finalInvocation?.code || null, timedOut: Boolean(finalInvocation?.timedOut) } });
        await new Promise(resolvePromise => setImmediate(resolvePromise));
      }
      return finalInvocation;
    }
  });

  const finalBudget = budgetTracker.snapshot();
  events.emit(result.status === 'completed' ? 'stage.completed' : 'stage.failed', {
    stage: budgetStep,
    role,
    modelId: result.successfulModel,
    data: { status: result.status, code: result.code || null, attemptedModels: result.attemptedModels || [], budget: finalBudget }
  });

  return {
    ...result,
    taskId,
    role,
    agent,
    poolName,
    logPath,
    eventLogPath: events.path,
    stepStartedAt,
    attemptDetails,
    attemptedModels: result.attemptedModels || result.attempts?.map(item => item.modelId) || [],
    successfulModel: result.successfulModel || null,
    budget: finalBudget
  };
}
