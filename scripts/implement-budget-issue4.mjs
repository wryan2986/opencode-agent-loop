#!/usr/bin/env node

import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
  console.log(`Updated ${path}`);
}

function replaceOnce(path, before, after) {
  const current = read(path);
  if (!current.includes(before)) {
    throw new Error(`Expected text not found in ${path}: ${before.slice(0, 120)}`);
  }
  const next = current.replace(before, after);
  write(path, next);
}

function updateJson(path, mutate) {
  const value = JSON.parse(read(path));
  mutate(value);
  write(path, JSON.stringify(value, null, 2) + '\n');
}

updateJson('config/free-first-config.json', config => {
  config.version = '1.1.0';
  config.budgets = {
    enabled: true,
    max_tokens_per_task: 250000,
    max_input_tokens_per_task: 200000,
    max_output_tokens_per_task: 50000,
    max_cost_usd_per_task: 1,
    fail_closed_on_unknown_pricing: false,
    unknown_paid_model_pricing: {
      input_per_million_usd: 5,
      output_per_million_usd: 15,
      reasoning_per_million_usd: 15,
      cache_read_per_million_usd: 1,
      cache_write_per_million_usd: 5
    }
  };
  if (!config.retry.non_retryable_errors.includes('BUDGET_EXCEEDED')) {
    config.retry.non_retryable_errors.push('BUDGET_EXCEEDED');
  }
});

updateJson('config/model-registry.json', registry => {
  for (const model of registry.models || []) {
    const classification = String(model.classification || '').toLowerCase();
    if (classification.includes('free') || classification === 'local') continue;
    const match = String(model.notes || '').match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)\s+per\s+1M\s+tokens/i);
    if (match) {
      const input = Number(match[1]);
      const output = Number(match[2]);
      model.pricing = {
        input_per_million_usd: input,
        output_per_million_usd: output,
        reasoning_per_million_usd: output,
        cache_read_per_million_usd: input,
        cache_write_per_million_usd: input,
        source: 'registry-notes'
      };
    } else {
      model.pricing = {
        input_per_million_usd: null,
        output_per_million_usd: null,
        reasoning_per_million_usd: null,
        cache_read_per_million_usd: null,
        cache_write_per_million_usd: null,
        source: 'unknown'
      };
    }
  }
});

updateJson('package.json', pkg => {
  const budgetTest = 'node tests/budget-tests.mjs';
  if (!pkg.scripts.test.includes(budgetTest)) {
    pkg.scripts.test = `${budgetTest} && ${pkg.scripts.test}`;
  }
});

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  "import { resolve } from 'node:path';\n",
  "import { resolve } from 'node:path';\nimport { normalizeTokenUsage } from '../lib/budget-manager.mjs';\n"
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `function parseJsonEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore formatted text mixed into --format json output.
    }
  }
  return events;
}
`,
  `function parseJsonEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore formatted text mixed into --format json output.
    }
  }
  return events;
}

export function extractUsageFromEvent(event) {
  const part = event?.part || event?.properties?.part;
  if (!part || (event?.type !== 'step_finish' && part.type !== 'step-finish')) return null;
  const usage = normalizeTokenUsage(part.tokens || event.tokens || {});
  const reportedCostUsd = Number(part.cost ?? event.cost ?? 0);
  return {
    usage,
    reportedCostUsd: Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0 ? reportedCostUsd : 0
  };
}

function addUsage(target, usage) {
  target.input += usage.input;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.total += usage.total;
}
`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `  latencyTimeoutMapping = {},
  stdoutTailCallback
}) {`,
  `  latencyTimeoutMapping = {},
  stdoutTailCallback,
  onUsage
}) {`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `    let lastTailTs = 0;
    const TAIL_LINES = 20;
    const TAIL_THROTTLE_MS = 2000;
`,
  `    let lastTailTs = 0;
    let jsonLineBuffer = '';
    let usageEvents = 0;
    let reportedCostUsd = 0;
    let budgetExceeded = false;
    let budgetSnapshot = null;
    const usage = normalizeTokenUsage();
    const TAIL_LINES = 20;
    const TAIL_THROTTLE_MS = 2000;

    function consumeJsonOutput(text, flush = false) {
      jsonLineBuffer += text;
      const lines = jsonLineBuffer.split(/\\r?\\n/);
      const tail = lines.pop() || '';
      jsonLineBuffer = flush ? '' : tail;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const event = JSON.parse(trimmed);
          const extracted = extractUsageFromEvent(event);
          if (!extracted) continue;
          usageEvents += 1;
          addUsage(usage, extracted.usage);
          reportedCostUsd += extracted.reportedCostUsd;
          if (onUsage && !budgetExceeded) {
            const decision = onUsage({
              modelId: model,
              usage: extracted.usage,
              reportedCostUsd: extracted.reportedCostUsd,
              event
            });
            if (decision?.exceeded === true || decision?.allowed === false) {
              budgetExceeded = true;
              budgetSnapshot = decision;
              if (!child.killed) child.kill('SIGTERM');
            }
          }
        } catch {
          // Ignore non-JSON output mixed into the stream.
        }
      }
      if (flush && tail.trim().startsWith('{')) {
        try {
          const event = JSON.parse(tail.trim());
          const extracted = extractUsageFromEvent(event);
          if (extracted) {
            usageEvents += 1;
            addUsage(usage, extracted.usage);
            reportedCostUsd += extracted.reportedCostUsd;
          }
        } catch {}
      }
    }
`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      lastActivityAt = Date.now();
`,
  `    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      consumeJsonOutput(text);
      lastActivityAt = Date.now();
`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `      resolve({
        success: false, stdout, stderr, exitCode: -1, signal: null, error,
        timedOut: false, lastActivityAt,
        ...providerError
      });`,
  `      consumeJsonOutput('', true);
      resolve({
        success: false, stdout, stderr, exitCode: -1, signal: null, error,
        timedOut: false, lastActivityAt,
        usage, reportedCostUsd, usageEvents,
        usageReportedIncrementally: usageEvents > 0,
        budgetExceeded, budget: budgetSnapshot,
        ...providerError
      });`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `      flushProgress();
      const providerError = extractProviderError({ stdout, stderr, exitCode });
      const session = extractSessionId(stdout, stderr);
      resolve({
        success: exitCode === 0 && !timedOut,
`,
  `      flushProgress();
      consumeJsonOutput('', true);
      const providerError = extractProviderError({ stdout, stderr, exitCode });
      const session = extractSessionId(stdout, stderr);
      resolve({
        success: exitCode === 0 && !timedOut && !budgetExceeded,
`
);

replaceOnce(
  'runtime/opencode-worker-runner.mjs',
  `        sessionId: session,
        lastActivityAt,
        error: exitCode === 0 && !timedOut ? undefined : providerError,
        statusCode: providerError.statusCode,
        code: timedOut ? 'ETIMEDOUT' : providerError.code
`,
  `        sessionId: session,
        lastActivityAt,
        usage,
        reportedCostUsd,
        usageEvents,
        usageReportedIncrementally: usageEvents > 0,
        budgetExceeded,
        budget: budgetSnapshot,
        error: exitCode === 0 && !timedOut && !budgetExceeded ? undefined : providerError,
        statusCode: providerError.statusCode,
        code: budgetExceeded ? 'BUDGET_EXCEEDED' : timedOut ? 'ETIMEDOUT' : providerError.code
`
);

replaceOnce(
  'lib/smoke-test.mjs',
  `  signal,
  progressCallback
}) {`,
  `  signal,
  progressCallback,
  onUsage
}) {`
);

replaceOnce(
  'lib/smoke-test.mjs',
  `  const results = { responsive: [], unresponsive: [], skipped: [] };`,
  `  const results = { responsive: [], unresponsive: [], skipped: [], budgetExceeded: false, budget: null };`
);

replaceOnce(
  'lib/smoke-test.mjs',
  `        signal,
        title: \`smoke-test-\${modelId.replace(/[^a-z0-9]/gi, '-')}\`
`,
  `        signal,
        title: \`smoke-test-\${modelId.replace(/[^a-z0-9]/gi, '-')}\`,
        onUsage
`
);

replaceOnce(
  'lib/smoke-test.mjs',
  `      const elapsed = Date.now() - startedAt;
      if (invocation.success === true) {`,
  `      const elapsed = Date.now() - startedAt;
      if (invocation.budgetExceeded) {
        results.budgetExceeded = true;
        results.budget = invocation.budget || null;
        results.unresponsive.push({ modelId, provider, elapsed, timedOut: false, error: 'BUDGET_EXCEEDED' });
        await updateProgress(progressCallback, 'Task budget exceeded during smoke test', { model: modelId, action: 'budget-exceeded', status: 'blocked', budget: results.budget });
        break;
      }
      if (invocation.success === true) {`
);

replaceOnce(
  'lib/failover-handler.mjs',
  `  async runWithFailover({ taskId, role, poolName, models, invoke, paidFallback, paidApproved = false, log = () => {} }) {`,
  `  async runWithFailover({ taskId, role, poolName, models, invoke, paidFallback, paidApproved = false, log = () => {}, canAttempt }) {`
);

replaceOnce(
  'lib/failover-handler.mjs',
  `      const attempt = {
        modelId,`,
  `      if (canAttempt) {
        const guard = await canAttempt({ modelId, tier, attemptIndex: index, attempts: attempts.slice() });
        if (guard?.allowed === false) {
          log({ type: 'budget-denied', taskId, role, modelId, reason: guard.reason });
          return {
            status: 'failed',
            code: guard.code || 'BUDGET_EXCEEDED',
            reason: guard.reason || 'Task budget exceeded',
            attempts,
            attemptedModels: attempts.map(a => a.modelId),
            successfulModel: null,
            budget: guard.budget || null
          };
        }
      }

      const attempt = {
        modelId,`
);

replaceOnce(
  'lib/failover-handler.mjs',
  `        attempt.finishedAt = new Date().toISOString();
        attempt.exitCode = result?.exitCode;
        attempt.sessionId = result?.sessionId || result?.sessionID || null;
        if (result?.success === true || result?.ok === true) {`,
  `        attempt.finishedAt = new Date().toISOString();
        attempt.exitCode = result?.exitCode;
        attempt.sessionId = result?.sessionId || result?.sessionID || null;
        if (result?.budgetExceeded === true || result?.code === 'BUDGET_EXCEEDED') {
          attempt.success = false;
          attempt.retryable = false;
          attempt.failureCategory = 'budget';
          attempt.reason = 'BUDGET_EXCEEDED';
          attempts.push(attempt);
          log({ type: 'budget-exceeded', taskId, role, modelId, budget: result?.budget || null });
          return {
            status: 'failed',
            code: 'BUDGET_EXCEEDED',
            reason: result?.budget?.exceededReasons?.join('; ') || 'Task budget exceeded',
            attempts,
            attemptedModels: attempts.map(a => a.modelId),
            successfulModel: null,
            result,
            budget: result?.budget || null
          };
        }
        if (result?.success === true || result?.ok === true) {`
);

replaceOnce(
  'lib/failover-handler.mjs',
  `      } catch (error) {
        const classification = this.classifyFailure(error);`,
  `      } catch (error) {
        if (error?.code === 'BUDGET_EXCEEDED' || error?.budgetExceeded === true) {
          attempt.finishedAt = new Date().toISOString();
          attempt.success = false;
          attempt.retryable = false;
          attempt.failureCategory = 'budget';
          attempt.reason = 'BUDGET_EXCEEDED';
          attempts.push(attempt);
          return {
            status: 'failed',
            code: 'BUDGET_EXCEEDED',
            reason: error?.message || 'Task budget exceeded',
            attempts,
            attemptedModels: attempts.map(a => a.modelId),
            successfulModel: null,
            budget: error?.budget || null
          };
        }
        const classification = this.classifyFailure(error);`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `import { reapExpiredCooldowns } from '../lib/cooldown-manager.mjs';
`,
  `import { reapExpiredCooldowns } from '../lib/cooldown-manager.mjs';
import { BudgetTracker } from '../lib/budget-manager.mjs';
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `const DEFAULT_LOG_DIR = resolve(PACKAGE_ROOT, '.opencode', 'agent-loop-logs');
`,
  `const DEFAULT_LOG_DIR = resolve(PACKAGE_ROOT, '.opencode', 'agent-loop-logs');
const DEFAULT_REGISTRY_PATH = resolve(PACKAGE_ROOT, 'config/model-registry.json');
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `  poolsPath = resolve(PACKAGE_ROOT, 'config/free-first-pools.json'),
  logDir = DEFAULT_LOG_DIR,
  forceModels,
  progressCallback
`,
  `  poolsPath = resolve(PACKAGE_ROOT, 'config/free-first-pools.json'),
  registryPath = DEFAULT_REGISTRY_PATH,
  logDir = DEFAULT_LOG_DIR,
  forceModels,
  progressCallback,
  budgetTaskId = taskId,
  budgetStep = role
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `  const freeFirstConfig = loadFreeFirstConfig(configPath);
  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);
`,
  `  const freeFirstConfig = loadFreeFirstConfig(configPath);
  const { providerTimeouts, latencyTimeoutMapping } = extractProviderTimeoutConfig(freeFirstConfig);
  const budgetTracker = BudgetTracker.fromFiles({
    taskId: budgetTaskId,
    step: budgetStep,
    configPath,
    registryPath
  });
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `    paidApproved: metadata.paidApproved === true || process.env.AGENT_LOOP_PAID_APPROVED === '1',
    log: event => writeAttemptLog(logPath, event),
    invoke: async ({ modelId, tier, attemptIndex, attempts }) => {`,
  `    paidApproved: metadata.paidApproved === true || process.env.AGENT_LOOP_PAID_APPROVED === '1',
    log: event => writeAttemptLog(logPath, event),
    canAttempt: async () => {
      const budget = budgetTracker.snapshot();
      return budgetTracker.canContinue()
        ? { allowed: true, budget }
        : { allowed: false, code: 'BUDGET_EXCEEDED', reason: budget.exceededReasons.join('; '), budget };
    },
    invoke: async ({ modelId, tier, attemptIndex, attempts }) => {`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `      const invocation = await workerAdapter({
`,
  `      let usageRecordedIncrementally = false;
      const invocation = await workerAdapter({
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `        latencyTimeoutMapping,
        stdoutTailCallback
      });
      writeFileSync(attemptLog, [`,
  `        latencyTimeoutMapping,
        stdoutTailCallback,
        onUsage: ({ usage, reportedCostUsd }) => {
          usageRecordedIncrementally = true;
          const budget = budgetTracker.recordUsage({ modelId, usage, reportedCostUsd, step: budgetStep });
          writeAttemptLog(logPath, { type: 'budget-usage', taskId: budgetTaskId, step: budgetStep, modelId, usage, budget });
          if (progressCallback) {
            progressCallback({ title: \`Budget: \${budget.used.total} tokens / $\${budget.used.billableCostUsd.toFixed(4)}\`, metadata: { action: 'budget', budget } });
          }
          return budget;
        }
      });
      if (!usageRecordedIncrementally && invocation?.usage) {
        invocation.budget = budgetTracker.recordUsage({
          modelId,
          usage: invocation.usage,
          reportedCostUsd: invocation.reportedCostUsd,
          step: budgetStep
        });
      }
      const budget = budgetTracker.snapshot();
      if (budget.exceeded) {
        invocation.success = false;
        invocation.code = 'BUDGET_EXCEEDED';
        invocation.budgetExceeded = true;
        invocation.budget = budget;
      }
      writeFileSync(attemptLog, [`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `        \`exitCode=\${invocation.exitCode ?? ''}\`,
        '--- stdout ---',`,
  `        \`exitCode=\${invocation.exitCode ?? ''}\`,
        \`usage=\${JSON.stringify(invocation.usage || {})}\`,
        \`reportedCostUsd=\${invocation.reportedCostUsd || 0}\`,
        \`budgetExceeded=\${invocation.budgetExceeded === true}\`,
        '--- stdout ---',`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `        code: invocation.code || null,
        logPath: attemptLog,
        progressLogPath
`,
  `        code: invocation.code || null,
        usage: invocation.usage || null,
        reportedCostUsd: invocation.reportedCostUsd || 0,
        budgetExceeded: invocation.budgetExceeded === true,
        budget: invocation.budget || budgetTracker.snapshot(),
        logPath: attemptLog,
        progressLogPath
`
);

replaceOnce(
  'runtime/execute-agent-task.mjs',
  `    successfulModel: result.successfulModel || null
`,
  `    successfulModel: result.successfulModel || null,
    budget: budgetTracker.snapshot()
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `import { reapExpiredCooldowns, filterRetiredModels, loadRegistry } from '../lib/cooldown-manager.mjs';
`,
  `import { reapExpiredCooldowns, filterRetiredModels, loadRegistry } from '../lib/cooldown-manager.mjs';
import { BudgetTracker } from '../lib/budget-manager.mjs';
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `const DEFAULT_POOLS_PATH = resolve(PACKAGE_ROOT, 'config/free-first-pools.json');
`,
  `const DEFAULT_POOLS_PATH = resolve(PACKAGE_ROOT, 'config/free-first-pools.json');
const DEFAULT_REGISTRY_PATH = resolve(PACKAGE_ROOT, 'config/model-registry.json');
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const smokeTestEnabled = config?.general?.smoke_test_enabled !== false;
`,
  `  const config = loadConfig(DEFAULT_CONFIG_PATH);
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
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback
`,
  `        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback, onUsage: onSmokeUsage
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `      await updateProgress(progressCallback, \`Smoke test: \${smokeResults.responsive.length}/\${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive\`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
    }
    const hasResponsive`,
  `      await updateProgress(progressCallback, \`Smoke test: \${smokeResults.responsive.length}/\${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive\`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
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
    const hasResponsive`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `      requiresUserInput: !hasResponsive, logPath: '',
      steps: [{ step: 'smoke', status: hasResponsive ? 'completed' : 'failed', attemptedModels: (smokeResults?.responsive || []).map(r => r.modelId), smokeResults: { responsive: smokeResults?.responsive || [], unresponsive: smokeResults?.unresponsive || [] } }]
`,
  `      requiresUserInput: !hasResponsive, logPath: '',
      budget: budgetTracker.snapshot(),
      steps: [{ step: 'smoke', status: hasResponsive ? 'completed' : 'failed', attemptedModels: (smokeResults?.responsive || []).map(r => r.modelId), smokeResults: { responsive: smokeResults?.responsive || [], unresponsive: smokeResults?.unresponsive || [] }, budget: budgetTracker.snapshot() }]
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback
`,
  `        cwd, env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) }, signal, progressCallback, onUsage: onSmokeUsage
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `      await updateProgress(progressCallback, \`Smoke test: \${smokeResults.responsive.length}/\${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive\`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
    }
    if (smokeResults && smokeResults.responsive.length === 0`,
  `      await updateProgress(progressCallback, \`Smoke test: \${smokeResults.responsive.length}/\${smokeResults.responsive.length + smokeResults.unresponsive.length} responsive\`, { smoke: { responsive: smokeResults.responsive, unresponsive: smokeResults.unresponsive }, status: 'smoke-done' });
    }
    if (smokeResults?.budgetExceeded || !budgetTracker.canContinue()) {
      const budget = budgetTracker.snapshot();
      return { status: 'failed', code: 'BUDGET_EXCEEDED', taskId, summary: budget.exceededReasons.join('; ') || 'Task budget exceeded during smoke test.', successfulModel: null, attemptedModels: [], changedFiles: [], smokeResults, budget, tests: { status: 'not-run', commands: [] }, review: { status: 'not-run' }, requiresUserInput: false, logPath: '', steps: [{ step: 'smoke', status: 'failed', code: 'BUDGET_EXCEEDED', budget }] };
    }
    if (smokeResults && smokeResults.responsive.length === 0`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `    env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) },
    progressCallback
`,
  `    env: { ...env, AGENT_LOOP_DEPTH: String(getCurrentDepth() + 1) },
    progressCallback,
    budgetTaskId: taskId,
    budgetStep: step.label,
    registryPath: DEFAULT_REGISTRY_PATH
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `    status: stepStatus === 'passed' ? 'completed' : 'failed',
    taskId,
    summary: stepStatus === 'passed' ? \`Agent loop completed (\${step.label}).\` : \`\${step.label} step did not pass.\`,
`,
  `    status: stepStatus === 'passed' ? 'completed' : 'failed',
    code: result.code || null,
    taskId,
    summary: result.code === 'BUDGET_EXCEEDED'
      ? (result.budget?.exceededReasons?.join('; ') || 'Task budget exceeded.')
      : stepStatus === 'passed' ? \`Agent loop completed (\${step.label}).\` : \`\${step.label} step did not pass.\`,
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `    logPath: result.logPath || '',
    steps: [{
`,
  `    logPath: result.logPath || '',
    budget: result.budget || budgetTracker.snapshot(),
    steps: [{
`
);

replaceOnce(
  'runtime/agent-loop-controller.mjs',
  `      attemptDetails: result.attemptDetails || null,
      smokeResults:`,
  `      attemptDetails: result.attemptDetails || null,
      budget: result.budget || budgetTracker.snapshot(),
      smokeResults:`
);

replaceOnce(
  '.opencode/plugins/agent-loop.js',
  `      progressLogPath: a.progressLogPath
`,
  `      progressLogPath: a.progressLogPath,
      usage: a.usage || undefined,
      reportedCostUsd: a.reportedCostUsd || 0,
      budgetExceeded: a.budgetExceeded === true,
      budget: a.budget || undefined
`
);

replaceOnce(
  '.opencode/plugins/agent-loop.js',
  `    stepStartedAt: s.stepStartedAt || undefined
`,
  `    stepStartedAt: s.stepStartedAt || undefined,
    budget: s.budget || undefined
`
);

replaceOnce(
  '.opencode/plugins/agent-loop.js',
  `    logPath: result.logPath,
    steps
`,
  `    logPath: result.logPath,
    budget: result.budget || undefined,
    steps
`
);

replaceOnce(
  '.opencode/plugins/agent-loop.js',
  `          models: tool.schema.array(tool.schema.string()).optional().describe('Pre-verified model IDs from a prior smoke call to restrict which models are used.')
`,
  `          models: tool.schema.array(tool.schema.string()).optional().describe('Pre-verified model IDs from a prior smoke call to restrict which models are used.'),
          taskId: tool.schema.string().min(1).max(128).optional().describe('Stable task ID used to share token and cost budgets across build, test, and review calls.')
`
);

replaceOnce(
  '.opencode/plugins/agent-loop.js',
  `              forceModels: args.models || undefined
`,
  `              forceModels: args.models || undefined,
              taskId: args.taskId || undefined
`
);

replaceOnce(
  'docs/configuration.md',
  `- paid-call limits
`,
  `- paid-call limits
- per-task token and cost budgets
`
);

replaceOnce(
  'docs/configuration.md',
  `## Provider cooldowns
`,
  `## Task budgets

The \`budgets\` section in \`config/free-first-config.json\` enforces a shared limit for a task ID across smoke, build, test, review, and failover attempts.

Default limits are:

- 250,000 total tokens
- 200,000 input tokens
- 50,000 output plus reasoning tokens
- $1.00 estimated or provider-reported cost

OpenCode \`step_finish\` events provide input, output, reasoning, cache-read, cache-write, and provider-reported cost data. The runtime tracks those values by task step and model. Cost estimation uses structured \`pricing\` fields in \`config/model-registry.json\`; legacy price text is supported for compatibility. Unknown paid-model prices use the conservative fallback rates in \`unknown_paid_model_pricing\` unless \`fail_closed_on_unknown_pricing\` is enabled.

When any limit is crossed, the active worker is terminated, failover stops, and the structured result returns \`code: "BUDGET_EXCEEDED"\` with the complete budget snapshot. Reuse the same optional \`taskId\` in sequential \`agent_loop\` calls to share one budget across stages.

## Provider cooldowns
`
);

replaceOnce(
  'CHANGELOG.md',
  `# Changelog

`,
  `# Changelog

## [Unreleased]

### Added

- Added configurable per-task token and cost budgets with live OpenCode usage tracking, model-registry pricing estimates, failover interruption, and structured budget output. Closes #4.

`
);

console.log('Issue #4 budget implementation applied.');
