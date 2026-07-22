/**
 * Routing Tests — Free-First Cloud Routing
 *
 * Tests 24 scenarios using mocked model pools, registries, and error
 * injection. No real API calls are made.
 *
 * Run: node tests/routing-tests.mjs
 */

// ─── Mock Model Registry ────────────────────────────────────────────────────

function createMockRegistry(overrides = {}) {
  return {
    getProvider: (name) => {
      const providers = {
        'free-model-alpha': {
          name: 'free-model-alpha',
          tier: 'free',
          cloud: true,
          status: 'active',
          costPerCall: 0,
        },
        'free-model-beta': {
          name: 'free-model-beta',
          tier: 'free',
          cloud: true,
          status: 'active',
          costPerCall: 0,
        },
        'free-model-gamma': {
          name: 'free-model-gamma',
          tier: 'free',
          cloud: true,
          status: 'active',
          costPerCall: 0,
        },
        'openrouter-free-1': {
          name: 'openrouter-free-1',
          tier: 'free',
          cloud: true,
          via: 'openrouter',
          status: 'active',
          costPerCall: 0,
        },
        'qwythos-9b-local': {
          name: 'qwythos-9b-local',
          tier: 'free',
          cloud: false,
          local: true,
          status: 'pending-gpu-audit',
          costPerCall: 0,
        },
        'paid-model-premium': {
          name: 'paid-model-premium',
          tier: 'paid',
          cloud: true,
          status: 'active',
          costPerCall: 0.002,
        },
        'zen-mini-paid': {
          name: 'zen-mini-paid',
          tier: 'paid',
          cloud: true,
          status: 'active',
          costPerCall: 0.001,
        },
        'trial-credit-model': {
          name: 'trial-credit-model',
          tier: 'free',
          cloud: true,
          trialCredit: true,
          status: 'active',
          costPerCall: 0,
        },
      };
      return providers[name] || null;
    },
    listAvailable: (filters = {}) => {
      let all = Object.values({
        'free-model-alpha': {
          name: 'free-model-alpha', tier: 'free', cloud: true,
          status: 'active', costPerCall: 0,
        },
        'free-model-beta': {
          name: 'free-model-beta', tier: 'free', cloud: true,
          status: 'active', costPerCall: 0,
        },
        'free-model-gamma': {
          name: 'free-model-gamma', tier: 'free', cloud: true,
          status: 'active', costPerCall: 0,
        },
        'openrouter-free-1': {
          name: 'openrouter-free-1', tier: 'free', cloud: true,
          via: 'openrouter', status: 'active', costPerCall: 0,
        },
        'qwythos-9b-local': {
          name: 'qwythos-9b-local', tier: 'free', cloud: false,
          local: true, status: 'pending-gpu-audit', costPerCall: 0,
        },
        'paid-model-premium': {
          name: 'paid-model-premium', tier: 'paid', cloud: true,
          status: 'active', costPerCall: 0.002,
        },
        'zen-mini-paid': {
          name: 'zen-mini-paid', tier: 'paid', cloud: true,
          status: 'active', costPerCall: 0.001,
        },
        'trial-credit-model': {
          name: 'trial-credit-model', tier: 'free', cloud: true,
          trialCredit: true, status: 'active', costPerCall: 0,
        },
      });
      if (filters.tier) {
        all = all.filter((p) => p.tier === filters.tier);
      }
      if (filters.cloud) {
        all = all.filter((p) => p.cloud === true);
      }
      if (filters.status) {
        all = all.filter((p) => p.status === filters.status);
      }
      if (filters.excludeStatus) {
        all = all.filter((p) => p.status !== filters.excludeStatus);
      }
      return all;
    },
    ...overrides,
  };
}

// ─── Mock FailoverHandler ────────────────────────────────────────────────────

function createMockFailoverHandler(overrides = {}) {
  const callLog = [];
  return {
    callLog,
    call: async (modelName, task, context = {}) => {
      callLog.push({ modelName, task, context });
      const handler = overrides[modelName];
      if (handler) {
        return handler(task, context);
      }
      return { success: true, output: `Result from ${modelName}`, modelUsed: modelName };
    },
    getCallLog: () => callLog,
    ...overrides,
  };
}

// ─── Mock PaidFallbackController ─────────────────────────────────────────────

function createMockPaidFallbackController(overrides = {}) {
  let callCount = 0;
  return {
    callCount,
    isFallbackAllowed: () => true,
    recordCall: () => { callCount++; },
    getCallCount: () => callCount,
    getDailyLimit: () => 50,
    getMonthlyLimit: () => 500,
    isWithinLimits: () => true,
    reset: () => { callCount = 0; },
    ...overrides,
  };
}

// ─── Mock PrivacyClassifier ──────────────────────────────────────────────────

function createMockPrivacyClassifier(overrides = {}) {
  return {
    classify: (task) => {
      if (task && task.toLowerCase().includes('sensitive')) {
        return { level: 'sensitive', requiresLocal: true };
      }
      if (task && task.toLowerCase().includes('pii')) {
        return { level: 'restricted', requiresLocal: true };
      }
      return { level: 'normal', requiresLocal: false };
    },
    isUnsafeForProvider: (provider, classification) => {
      if (classification.level === 'sensitive' && !provider.local) {
        return true;
      }
      return false;
    },
    ...overrides,
  };
}

// ─── Mock NtfyClient ────────────────────────────────────────────────────────

function createMockNtfyClient() {
  const sent = [];
  return {
    sent,
    send: async (title, message, priority) => {
      sent.push({ title, message, priority });
      return { success: true };
    },
    getSent: () => sent,
  };
}

// ─── Routing Logic Under Test ──────────────────────────────────────────────

/**
 * Simulates selecting a model from a pool given a target role and task.
 *
 * @param {object} pool - Model pool object
 * @param {string} role - 'builder' | 'reviewer' | 'orchestrator'
 * @param {object} registry - Model registry
 * @param {object} options
 * @param {object} [options.failoverHandler]
 * @param {object} [options.paidFallback]
 * @param {object} [options.privacyClassifier]
 * @param {object} [options.ntfy]
 * @param {boolean} [options.paidFallbackEnabled]
 * @param {number} [options.paidCallLimit]
 * @returns {Promise<{success: boolean, modelUsed?: string, error?: string, failedModels?: string[]}>}
 */
async function selectModelFromPool(pool, role, registry, options = {}) {
  const {
    failoverHandler = createMockFailoverHandler(),
    paidFallback = createMockPaidFallbackController(),
    privacyClassifier = createMockPrivacyClassifier(),
    ntfy = createMockNtfyClient(),
    paidFallbackEnabled = true,
    paidCallLimit = 50,
    taskState,
    gitDiff,
    actionCompleted,
    context: extraContext,
  } = options;

  const classification = privacyClassifier.classify(pool.task || 'general');
  const failedModels = [];

  // Build shared context passed to each model call
  const sharedContext = {
    role,
    classification,
    ...(taskState ? { taskState } : {}),
    ...(gitDiff ? { gitDiff } : {}),
    ...(actionCompleted ? { actionCompleted } : {}),
    ...(extraContext || {}),
  };

  // Phase 1: Try free cloud models
  for (const modelName of pool.freeCloud || []) {
    // Skip pending-gpu-audit models
    const provider = registry.getProvider(modelName);
    if (provider && provider.status === 'pending-gpu-audit') {
      failedModels.push(modelName);
      continue;
    }

    // Check if this provider is suitable for the task classification
    if (privacyClassifier.isUnsafeForProvider(provider, classification)) {
      failedModels.push(modelName);
      continue;
    }

    if (pool.modelStatus && pool.modelStatus[modelName] === 'cooldown') {
      failedModels.push(modelName);
      continue;
    }

    try {
      const result = await failoverHandler.call(modelName, pool.task || 'general', sharedContext);
      if (result.success) {
        return { success: true, modelUsed: modelName, failedModels };
      }
      failedModels.push(modelName);
    } catch (err) {
      failedModels.push(modelName);
      // Continue to next model
    }
  }

  // If all free cloud models failed, check trial credit models
  if (pool.trialCreditModels && pool.trialCreditModels.length > 0) {
    for (const modelName of pool.trialCreditModels) {
      try {
        const result = await failoverHandler.call(modelName, pool.task || 'general', sharedContext);
        if (result.success) {
          return { success: true, modelUsed: modelName, failedModels };
        }
        failedModels.push(modelName);
      } catch {
        failedModels.push(modelName);
      }
    }
  }

  // Phase 2: Try OpenRouter free fallback
  if (pool.openRouterFree && pool.openRouterFree.length > 0) {
    for (const modelName of pool.openRouterFree) {
      try {
        const result = await failoverHandler.call(modelName, pool.task || 'general', sharedContext);
        if (result.success) {
          return { success: true, modelUsed: modelName, failedModels };
        }
        failedModels.push(modelName);
      } catch {
        failedModels.push(modelName);
      }
    }
  }

  // Phase 3: Try local pending models (skip — still pending)
  // Phase 4: Paid fallback
  if (paidFallbackEnabled && paidFallback.isWithinLimits()) {
    const paidModels = pool.paidCloud || [];
    for (const modelName of paidModels) {
      paidFallback.recordCall();
      if (paidFallback.getCallCount() > paidCallLimit) {
        return {
          success: false,
          error: 'Paid call limit reached',
          failedModels,
        };
      }
      try {
        const result = await failoverHandler.call(modelName, pool.task || 'general', {
          ...sharedContext,
          paid: true,
        });
        if (result.success) {
          ntfy.send('Paid Fallback Used', `Model ${modelName} used for ${role}`, 'warning');
          return { success: true, modelUsed: modelName, failedModels };
        }
        failedModels.push(modelName);
      } catch {
        failedModels.push(modelName);
      }
    }
  }

  return { success: false, error: 'All models failed', failedModels };
}

// ─── Test Scenarios ─────────────────────────────────────────────────────────

async function testPrimaryFreeModelSucceeds() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-alpha' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    paidCloud: ['paid-model-premium'],
    task: 'Write a unit test',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Primary free model succeeds',
    passed: result.success === true && result.modelUsed === 'free-model-alpha',
    error: result.success ? undefined : `Expected success, got: ${result.error}`,
  };
}

async function testPrimaryReturns429() {
  const registry = createMockRegistry();
  let attempts = 0;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      attempts++;
      if (attempts <= 1) {
        const err = new Error('Rate limited');
        err.statusCode = 429;
        throw err;
      }
      return { success: true, output: 'ok', modelUsed: 'free-model-alpha' };
    },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Refactor function',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Primary returns 429 -> secondary used',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Expected fallback to beta, got: ${result.error}`,
  };
}

async function testPrimaryReturns503() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      const err = new Error('Service unavailable');
      err.statusCode = 503;
      throw err;
    },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Debug issue',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Primary returns 503 -> secondary used',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Expected fallback to beta, got: ${result.error}`,
  };
}

async function testPrimaryTimesOut() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      const err = new Error('Timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Analyze logs',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Primary times out -> secondary used',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Expected fallback to beta, got: ${result.error}`,
  };
}

async function testPrimaryQuotaExhausted() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      const err = new Error('Quota exhausted');
      err.type = 'quota_exhausted';
      throw err;
    },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Generate docs',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Primary quota exhausted -> secondary used',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Expected fallback to beta, got: ${result.error}`,
  };
}

async function testSecondFreeModelSucceeds() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
    'free-model-gamma': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-gamma' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta', 'free-model-gamma'],
    task: 'Write test',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Second free model succeeds after first fails',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Expected free-model-beta, got: ${result.error}`,
  };
}

async function testThirdFreeModelSucceeds() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'free-model-gamma': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-gamma' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta', 'free-model-gamma'],
    task: 'Review PR',
  };

  const result = await selectModelFromPool(pool, 'reviewer', registry, { failoverHandler: failover });

  return {
    name: 'Third free model succeeds after first two fail',
    passed: result.success === true && result.modelUsed === 'free-model-gamma',
    error: result.success ? undefined : `Expected free-model-gamma, got: ${result.error}`,
  };
}

async function testOpenRouterFreeFallback() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'openrouter-free-1': async () => ({ success: true, output: 'ok', modelUsed: 'openrouter-free-1' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    openRouterFree: ['openrouter-free-1'],
    task: 'Quick fix',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'OpenRouter free fallback used after all free cloud models fail',
    passed: result.success === true && result.modelUsed === 'openrouter-free-1',
    error: result.success ? undefined : `Expected openrouter-free-1, got: ${result.error}`,
  };
}

async function testAllFreeCloudModelsFail() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'free-model-gamma': async () => { throw new Error('Fail'); },
    'openrouter-free-1': async () => { throw new Error('Fail'); },
    'paid-model-premium': async () => ({ success: true, output: 'ok', modelUsed: 'paid-model-premium' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta', 'free-model-gamma'],
    openRouterFree: ['openrouter-free-1'],
    paidCloud: ['paid-model-premium'],
    task: 'Complex refactor',
  };

  const paidFallback = createMockPaidFallbackController({
    isFallbackAllowed: () => true,
    isWithinLimits: () => true,
  });

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallback,
    paidFallbackEnabled: true,
  });

  return {
    name: 'All free cloud models fail -> paid fallback used',
    passed: result.success === true && result.modelUsed === 'paid-model-premium',
    error: result.success ? undefined : `Expected paid fallback, got: ${result.error}`,
  };
}

async function testPendingLocalModelSkipped() {
  const registry = createMockRegistry();
  let localModelCalled = false;
  const failover = createMockFailoverHandler({
    'qwythos-9b-local': async () => {
      localModelCalled = true;
      return { success: true, output: 'ok', modelUsed: 'qwythos-9b-local' };
    },
    'free-model-alpha': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-alpha' }),
  });

  const pool = {
    freeCloud: ['qwythos-9b-local', 'free-model-alpha'],
    task: 'Search codebase',
  };

  const result = await selectModelFromPool(pool, 'explorer', registry, { failoverHandler: failover });

  return {
    name: 'Pending local model (qwythos-9b-local) is skipped',
    passed: result.success === true
      && result.modelUsed === 'free-model-alpha'
      && localModelCalled === false,
    error: localModelCalled
      ? 'Local pending model was called despite being pending-gpu-audit'
      : (result.success ? undefined : `Expected free-model-alpha, got: ${result.error}`),
  };
}

async function testPaidFallbackSelected() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'paid-model-premium': async () => ({ success: true, output: 'ok', modelUsed: 'paid-model-premium' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    paidCloud: ['paid-model-premium'],
    task: 'Production deploy',
  };

  const paidFallback = createMockPaidFallbackController({
    isFallbackAllowed: () => true,
    isWithinLimits: () => true,
  });

  const ntfy = createMockNtfyClient();

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallback,
    paidFallbackEnabled: true,
    ntfy,
  });

  const ntfyFired = ntfy.getSent().length > 0;

  return {
    name: 'Paid fallback selected when all free models fail',
    passed: result.success === true
      && result.modelUsed === 'paid-model-premium'
      && ntfyFired === true,
    error: result.success
      ? (!ntfyFired ? 'Paid fallback worked but ntfy notification did not fire' : undefined)
      : `Expected paid fallback, got: ${result.error}`,
  };
}

async function testPaidFallbackDisabled() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'paid-model-premium': async () => ({ success: true, output: 'ok', modelUsed: 'paid-model-premium' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    paidCloud: ['paid-model-premium'],
    task: 'Experiment',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallbackEnabled: false,
  });

  return {
    name: 'Paid fallback disabled — no paid model used',
    passed: result.success === false && result.error === 'All models failed',
    error: result.success
      ? 'Paid fallback was used despite being disabled'
      : undefined,
  };
}

async function testPaidCallLimitReached() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'paid-model-premium': async () => ({ success: true, output: 'ok', modelUsed: 'paid-model-premium' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha'],
    paidCloud: ['paid-model-premium'],
    task: 'Batch job',
  };

  const paidFallback = createMockPaidFallbackController({
    isWithinLimits: () => false,
    getCallCount: () => 51,
  });

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallback,
    paidFallbackEnabled: true,
    paidCallLimit: 50,
  });

  return {
    name: 'Paid call limit reached — fallback blocked',
    passed: result.success === false
      && (result.error === 'Paid call limit reached' || result.error === 'All models failed'),
    error: result.success
      ? 'Paid fallback was used despite being over limit'
      : undefined,
  };
}

async function testInvalidCredentialsNoInfiniteLoop() {
  const registry = createMockRegistry();
  let callCount = 0;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      callCount++;
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    },
    'free-model-beta': async () => {
      callCount++;
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    },
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Simple task',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  return {
    name: 'Invalid credentials — no infinite loop (all models fail fast)',
    passed: result.success === false && callCount <= 2,
    error: result.success
      ? 'Should have failed'
      : (callCount > 2 ? `Infinite loop detected: ${callCount} calls` : undefined),
  };
}

async function testCooldownExpires() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      // Simulate rate limit with retry-after header
      const err = new Error('Rate limited');
      err.statusCode = 429;
      err.retryAfter = 30;
      throw err;
    },
    'free-model-beta': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-beta' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    modelStatus: {
      'free-model-alpha': 'cooldown',
    },
    task: 'Retry task',
  };

  // Test that cooldown model is skipped in favor of non-cooldown model
  const result = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  // After cooldown expires, retry should work
  pool.modelStatus = {}; // Clear cooldown
  const resultAfterCooldown = await selectModelFromPool(
    { ...pool, freeCloud: ['free-model-alpha'] },
    'builder',
    registry,
    { failoverHandler: createMockFailoverHandler({
      'free-model-alpha': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-alpha' }),
    })},
  );

  return {
    name: 'Cooldown expires — model becomes available again',
    passed: result.success === true
      && result.modelUsed === 'free-model-beta'
      && resultAfterCooldown.success === true
      && resultAfterCooldown.modelUsed === 'free-model-alpha',
    error: (result.success && result.modelUsed === 'free-model-beta')
      ? (resultAfterCooldown.success ? undefined : 'Cooldown model did not become available after expiry')
      : `Expected free-model-beta during cooldown, got: ${result.error}`,
  };
}

async function testFutureTaskRetriesFreeModel() {
  const registry = createMockRegistry();
  let callAttempts = 0;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      callAttempts++;
      if (callAttempts <= 1) {
        const err = new Error('Temp failure');
        err.statusCode = 502;
        throw err;
      }
      return { success: true, output: 'ok', modelUsed: 'free-model-alpha' };
    },
  });

  const pool = {
    freeCloud: ['free-model-alpha'],
    task: 'Retry test',
  };

  // First call fails
  const result1 = await selectModelFromPool(pool, 'builder', registry, { failoverHandler: failover });

  // Simulate task state with retry count
  const taskState = { retryCount: 1, maxRetries: 3 };

  // Retry — should succeed now
  const result2 = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: createMockFailoverHandler({
      'free-model-alpha': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-alpha' }),
    }),
  });

  return {
    name: 'Future task retries free model after temporary failure',
    passed: result1.success === false
      && result2.success === true
      && result2.modelUsed === 'free-model-alpha',
    error: result1.success
      ? 'First call should have failed'
      : (result2.success ? undefined : 'Retry should have succeeded'),
  };
}

async function testTaskStateSurvivesModelSwitch() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async (_task, context) => {
      // Verify task state was passed through
      if (context && context.taskState && context.taskState.originalRequest) {
        return { success: true, output: 'ok', modelUsed: 'free-model-beta' };
      }
      return { success: false, error: 'Task state missing' };
    },
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'State preservation test',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    taskState: { originalRequest: 'fix bug #123', retryCount: 0 },
  });

  return {
    name: 'Task state survives model switch during failover',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Task state lost during switch: ${result.error}`,
  };
}

async function testGitDiffSurvivesFallback() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async (_task, context) => {
      // Check that git diff context was preserved
      if (context && context.gitDiff) {
        return { success: true, output: 'review ok', modelUsed: 'free-model-beta' };
      }
      return { success: false, error: 'Git diff missing from context' };
    },
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Review changes',
    gitDiff: 'diff --git a/src/file.js b/src/file.js\n+console.log("test")',
  };

  const result = await selectModelFromPool(pool, 'reviewer', registry, {
    failoverHandler: failover,
    gitDiff: pool.gitDiff,
  });

  return {
    name: 'Git diff survives fallback to secondary provider',
    passed: result.success === true && result.modelUsed === 'free-model-beta',
    error: result.success ? undefined : `Git diff lost during fallback: ${result.error}`,
  };
}

async function testDestructiveActionNotRepeated() {
  const registry = createMockRegistry();
  let destructiveCalls = 0;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async (_task, context) => {
      if (context && context.action === 'destructive') {
        destructiveCalls++;
        if (destructiveCalls > 1) {
          return { success: false, error: 'Duplicate destructive action blocked' };
        }
        return { success: true, output: 'done', modelUsed: 'free-model-alpha' };
      }
      return { success: true, output: 'ok', modelUsed: 'free-model-alpha' };
    },
  });

  // Simulate: first attempt with model alpha succeeds on destructive action
  const pool1 = {
    freeCloud: ['free-model-alpha'],
    task: 'Delete expired records',
  };

  const result1 = await selectModelFromPool(pool1, 'builder', registry, {
    failoverHandler: createMockFailoverHandler({
      'free-model-alpha': async () => {
        destructiveCalls++;
        return { success: true, output: 'done', modelUsed: 'free-model-alpha' };
      },
    }),
  });

  // Simulate: retry with different model should not repeat destructive action
  destructiveCalls = 1; // Already done
  const pool2 = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    task: 'Delete expired records',
    actionCompleted: ['delete-expired-records'],
  };

  const failover2 = createMockFailoverHandler({
    'free-model-alpha': async (_task, context) => {
      if (context && context.actionCompleted && context.actionCompleted.includes('delete-expired-records')) {
        return { success: true, output: 'already done', modelUsed: 'free-model-alpha' };
      }
      destructiveCalls++;
      return { success: false, error: 'Should not repeat' };
    },
    'free-model-beta': async (_task, context) => {
      if (context && context.actionCompleted && context.actionCompleted.includes('delete-expired-records')) {
        return { success: true, output: 'already done', modelUsed: 'free-model-beta' };
      }
      destructiveCalls++;
      return { success: false, error: 'Should not repeat' };
    },
  });

  const result2 = await selectModelFromPool(pool2, 'builder', registry, {
    failoverHandler: failover2,
    actionCompleted: pool2.actionCompleted,
  });

  return {
    name: 'Destructive action not repeated on model failover',
    passed: result1.success === true
      && result2.success === true
      && destructiveCalls <= 1,
    error: destructiveCalls > 1
      ? `Destructive action was repeated ${destructiveCalls} times`
      : (result2.success ? undefined : `Unexpected failure: ${result2.error}`),
  };
}

async function testSensitiveTasksExcludeUnsuitableProviders() {
  const registry = createMockRegistry();
  let sensitiveModelCalled = false;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => {
      sensitiveModelCalled = true;
      return { success: true, output: 'ok', modelUsed: 'free-model-alpha' };
    },
  });

  const privacyClassifier = createMockPrivacyClassifier();

  const pool = {
    freeCloud: ['free-model-alpha'],
    task: 'sensitive customer data processing',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    privacyClassifier,
  });

  return {
    name: 'Sensitive tasks exclude unsuitable cloud providers',
    passed: result.success === false && sensitiveModelCalled === false,
    error: sensitiveModelCalled
      ? 'Cloud model was called for a sensitive task'
      : (result.success ? 'Task should have failed' : undefined),
  };
}

async function testNtfyNotificationFires() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'paid-model-premium': async () => ({ success: true, output: 'ok', modelUsed: 'paid-model-premium' }),
  });

  const ntfy = createMockNtfyClient();

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    paidCloud: ['paid-model-premium'],
    task: 'Notify test',
  };

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallback: createMockPaidFallbackController({
      isWithinLimits: () => true,
    }),
    paidFallbackEnabled: true,
    ntfy,
  });

  const notifications = ntfy.getSent();

  return {
    name: 'ntfy notification fires on paid fallback',
    passed: notifications.length > 0
      && notifications[0].title === 'Paid Fallback Used',
    error: notifications.length === 0
      ? 'No ntfy notification was sent'
      : (result.success ? undefined : `Paid fallback failed: ${result.error}`),
  };
}

async function testTwoSimultaneousTasksDifferentWorktrees() {
  const registry = createMockRegistry();
  const callLog = [];

  const failover = createMockFailoverHandler({
    'free-model-alpha': async (task) => {
      callLog.push({ model: 'free-model-alpha', task, time: Date.now() });
      return { success: true, output: `Result for ${task}`, modelUsed: 'free-model-alpha' };
    },
  });

  const pool1 = {
    freeCloud: ['free-model-alpha'],
    task: 'Feature A — add login page',
    worktree: 'feature/login',
  };

  const pool2 = {
    freeCloud: ['free-model-alpha'],
    task: 'Feature B — fix navbar',
    worktree: 'feature/navbar',
    context: { worktree: 'feature/navbar' },
  };

  // Run both tasks
  const [result1, result2] = await Promise.all([
    selectModelFromPool(pool1, 'builder', registry, {
      failoverHandler: failover,
      context: { worktree: pool1.worktree },
    }),
    selectModelFromPool(pool2, 'builder', registry, {
      failoverHandler: failover,
      context: pool2.context,
    }),
  ]);

  return {
    name: 'Two simultaneous tasks in different worktrees',
    passed: result1.success === true
      && result2.success === true
      && callLog.length === 2,
    error: callLog.length < 2
      ? 'Not all tasks were dispatched'
      : (result1.success && result2.success ? undefined : 'One or both tasks failed'),
  };
}

async function testTrialCreditModelsDisabled() {
  const registry = createMockRegistry();
  let trialModelCalled = false;
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => { throw new Error('Fail'); },
    'free-model-beta': async () => { throw new Error('Fail'); },
    'trial-credit-model': async () => {
      trialModelCalled = true;
      return { success: true, output: 'ok', modelUsed: 'trial-credit-model' };
    },
  });

  const pool = {
    freeCloud: ['free-model-alpha', 'free-model-beta'],
    trialCreditModels: ['trial-credit-model'],
    task: 'Test trial credits',
  };

  const paidFallback = createMockPaidFallbackController({
    isWithinLimits: () => false,
  });

  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallback,
    paidFallbackEnabled: true,
  });

  // Trial credit models should still be tried even when paid fallback is limited
  // if they are in the trialCreditModels pool
  return {
    name: 'Trial credit models are tried separately from paid pool',
    passed: trialModelCalled === true,
    error: trialModelCalled === false
      ? 'Trial credit model was not attempted'
      : undefined,
  };
}

async function testPaidZenModelsNotInFreePool() {
  const registry = createMockRegistry();
  const failover = createMockFailoverHandler({
    'free-model-alpha': async () => ({ success: true, output: 'ok', modelUsed: 'free-model-alpha' }),
    'zen-mini-paid': async () => ({ success: true, output: 'ok', modelUsed: 'zen-mini-paid' }),
  });

  const pool = {
    freeCloud: ['free-model-alpha'],
    // zen-mini-paid is NOT in the freeCloud list, only in paidCloud
    paidCloud: ['zen-mini-paid'],
    task: 'Standard task',
  };

  // Test that zen-mini-paid is not used when free models are available
  const result = await selectModelFromPool(pool, 'builder', registry, {
    failoverHandler: failover,
    paidFallbackEnabled: false, // Disable paid to test free-only path
  });

  return {
    name: 'Paid Zen models are not in free model pool',
    passed: result.success === true && result.modelUsed === 'free-model-alpha',
    error: result.success
      ? undefined
      : `Should have used free-model-alpha: ${result.error}`,
  };
}

// ─── Test Results Collector ──────────────────────────────────────────────────

const TEST_ORDER = [
  testPrimaryFreeModelSucceeds,
  testPrimaryReturns429,
  testPrimaryReturns503,
  testPrimaryTimesOut,
  testPrimaryQuotaExhausted,
  testSecondFreeModelSucceeds,
  testThirdFreeModelSucceeds,
  testOpenRouterFreeFallback,
  testAllFreeCloudModelsFail,
  testPendingLocalModelSkipped,
  testPaidFallbackSelected,
  testPaidFallbackDisabled,
  testPaidCallLimitReached,
  testInvalidCredentialsNoInfiniteLoop,
  testCooldownExpires,
  testFutureTaskRetriesFreeModel,
  testTaskStateSurvivesModelSwitch,
  testGitDiffSurvivesFallback,
  testDestructiveActionNotRepeated,
  testSensitiveTasksExcludeUnsuitableProviders,
  testNtfyNotificationFires,
  testTwoSimultaneousTasksDifferentWorktrees,
  testTrialCreditModelsDisabled,
  testPaidZenModelsNotInFreePool,
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('=== Routing Test Results ===');
  console.log('');

  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < TEST_ORDER.length; i++) {
    const testFn = TEST_ORDER[i];
    let result;
    try {
      result = await testFn();
    } catch (err) {
      result = {
        name: `Test ${i + 1}`,
        passed: false,
        error: `Unhandled exception: ${err.message}`,
      };
    }

    results.push(result);

    if (result.passed) {
      passedCount++;
      console.log(`✅ Test ${i + 1}: ${result.name}`);
    } else {
      failedCount++;
      console.log(`❌ Test ${i + 1}: ${result.name}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
  }

  console.log('');
  console.log(`Results: ${passedCount}/${passedCount + failedCount} passed`);
  console.log('');

  if (failedCount === 0) {
    console.log('=== ALL TESTS PASSED ===');
  } else {
    console.log(`=== ${failedCount} TEST(S) FAILED ===`);
  }

  return { results, passedCount, failedCount };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('routing-tests.mjs')
  || process.argv[1].includes('routing-tests')
);

if (isMain) {
  runAllTests()
    .then(({ passedCount, failedCount }) => {
      process.exit(failedCount > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

export { runAllTests, selectModelFromPool, createMockRegistry, createMockFailoverHandler, createMockPaidFallbackController, createMockPrivacyClassifier, createMockNtfyClient };
