import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FailoverHandler } from '../lib/failover-handler.mjs';
import { PaidFallbackController } from '../lib/paid-fallback.mjs';
import { loadPoolConfig, normalizePoolConfig, isModelCoolingDown } from '../lib/pool-normalizer.mjs';
import { runOpenCodeWorker, resolveTimeoutMs } from './opencode-worker-runner.mjs';
import { reapExpiredCooldowns } from '../lib/cooldown-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const DEFAULT_LOG_DIR = resolve(PACKAGE_ROOT, '.opencode', 'agent-loop-logs');

function loadFreeFirstConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function extractProviderTimeoutConfig(config) {
  const providerTimeouts = config?.provider_timeouts_ms || {};
  const latencyTimeoutMapping = config?.latency_timeout_mapping || {};
  return { providerTimeouts, latencyTimeoutMapping };
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
  return String(text || '')
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*=)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]')
    .slice(0, 4000);
}

function writeAttemptLog(logPath, event) {
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
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
  logDir = DEFAULT_LOG_DIR,
  forceModels,
  progressCallback
}) {
  if (!role) throw new Error('executeAgentTask requires role');
  if (!agent) throw new Error('executeAgentTask requires agent');
  if (!prompt) throw new Error('executeAgentTask requires prompt');

  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, `${taskId}-${role}.jsonl`);
  writeFileSync(logPath, '', 'utf8');

  // Reap expired cooldowns before selecting models — ensures recently-expired
  // models are available again.
  reapExpiredCooldowns();

  const poolName = resolvePoolName(role);
  const poolConfig = loadPoolConfig(poolsPath);
  const normalized = normalizePoolConfig(poolConfig, { role: poolName });
  let models = tieredModels(normalized);

  if (Array.isArray(forceModels) && forceModels.length > 0) {
    const forceSet = new Set(forceModels);
    models = models.filter(m => forceSet.has(m.modelId));
    if (models.length === 0) {
      return {
        status: 'failed',
        code: 'ALL_MODELS_FAILED',
        taskId, role, agent, poolName,
        attemptedModels: [],
        successfulModel: null,
        attemptDetails: [],
        stepStartedAt: new Date().toISOString(),
        logPath,
        summary: 'All responsive models from smoke test were filtered out before work began.'
      };
    }
  }

  const freeFirstConfig = loadFreeFirstConfig(configPath);
  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);

  const failover = new FailoverHandler(configPath, poolsPath);
  await failover.loadConfig();
  await failover.loadPools();
  const paidFallback = new PaidFallbackController(configPath);

  const attemptDetails = [];
  let stepStartedAt = new Date().toISOString();

  const result = await failover.runWithFailover({
    taskId,
    role: poolName,
    poolName,
    models,
    paidFallback,
    paidApproved: metadata.paidApproved === true || process.env.AGENT_LOOP_PAID_APPROVED === '1',
    log: event => writeAttemptLog(logPath, event),
    invoke: async ({ modelId, tier, attemptIndex, attempts }) => {
      const checkpoint = attempts.length > 0
        ? `\n\nPrevious provider attempts failed. Before editing, inspect repository state and git diff. Attempted models: ${attempts.map(a => a.modelId).join(', ')}.`
        : '';
      const workerPrompt = `${prompt}${checkpoint}`;
      const attemptLog = resolve(logDir, `${taskId}-${role}-attempt-${attemptIndex + 1}.log`);
      const progressLogPath = resolve(logDir, `${taskId}-${role}-attempt-${attemptIndex + 1}-progress.jsonl`);
      const attemptStartedAt = new Date().toISOString();
      const effectiveTimeoutMs = resolveTimeoutMs({ model: modelId, timeoutMs, providerTimeouts, latencyTimeoutMapping });
      if (progressCallback) {
        progressCallback({ title: `Trying ${modelId.split('/').pop()}...`, metadata: { model: modelId, tier, action: 'starting', attempt: attemptIndex + 1, timeoutMs: effectiveTimeoutMs } });
        await new Promise(r => setImmediate(r));
      }
      const modelLabel = modelId.split('/').pop();
      const stdoutTailCallback = (tail) => {
        if (progressCallback) {
          progressCallback({ title: modelLabel, metadata: { model: modelId, tail, action: 'progress', attempt: attemptIndex + 1 } });
        }
      };
      const invocation = await workerAdapter({
        cwd,
        agent,
        model: modelId,
        prompt: workerPrompt,
        timeoutMs: effectiveTimeoutMs,
        env: {
          ...env,
          AGENT_LOOP_PARENT_SESSION: parentSessionId || '',
          AGENT_LOOP_TASK_ID: taskId,
          AGENT_LOOP_ROLE: role,
          AGENT_LOOP_MODEL: modelId,
          AGENT_LOOP_WORKER_EXECUTABLE: process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode'
        },
        signal,
        title: taskId,
        progressLogPath,
        providerTimeouts,
        latencyTimeoutMapping,
        stdoutTailCallback
      });
      writeFileSync(attemptLog, [
        `model=${modelId}`,
        `tier=${tier}`,
        `timeoutMs=${effectiveTimeoutMs}`,
        `exitCode=${invocation.exitCode ?? ''}`,
        '--- stdout ---',
        redact(invocation.stdout),
        '--- stderr ---',
        redact(invocation.stderr)
      ].join('\n'), 'utf8');
      writeAttemptLog(logPath, { type: 'attempt-output', modelId, tier, attemptLog, progressLogPath, timedOut: invocation.timedOut });
      const detail = {
        modelId,
        tier,
        attemptIndex: attemptIndex + 1,
        startedAt: attemptStartedAt,
        finishedAt: new Date().toISOString(),
        timedOut: !!invocation.timedOut,
        lastActivityAt: invocation.lastActivityAt ? new Date(invocation.lastActivityAt).toISOString() : null,
        exitCode: invocation.exitCode,
        success: !!invocation.success,
        code: invocation.code || null,
        logPath: attemptLog,
        progressLogPath
      };
      attemptDetails.push(detail);
      const status = invocation.success ? 'ok' : invocation.timedOut ? 'timeout' : 'failed';
      const reason = invocation.success ? '' : invocation.code || 'error';
      if (progressCallback) {
        progressCallback({ title: `${modelId.split('/').pop()}: ${status}${reason ? ' (' + reason + ')' : ''}`, metadata: { model: modelId, action: 'result', status, code: invocation.code || null, timedOut: !!invocation.timedOut, elapsed: new Date() - new Date(attemptStartedAt) } });
        await new Promise(r => setImmediate(r));
      }
      return invocation;
    }
  });

  return {
    ...result,
    taskId,
    role,
    agent,
    poolName,
    logPath,
    stepStartedAt,
    attemptDetails,
    attemptedModels: result.attemptedModels || result.attempts?.map(a => a.modelId) || [],
    successfulModel: result.successfulModel || null
  };
}
