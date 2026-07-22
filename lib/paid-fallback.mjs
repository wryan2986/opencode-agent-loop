import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const PAID_STATE_VERSION = 1;

function safeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function readState(path) {
  if (!existsSync(path)) return { globalCallCount: 0, taskCallCounts: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.version !== PAID_STATE_VERSION) return { globalCallCount: 0, taskCallCounts: new Map() };
    return {
      globalCallCount: safeInteger(parsed.globalCallCount),
      taskCallCounts: new Map(
        Object.entries(parsed.taskCallCounts || {})
          .map(([taskId, count]) => [taskId, safeInteger(count)])
      )
    };
  } catch {
    return { globalCallCount: 0, taskCallCounts: new Map() };
  }
}

function sanitizeFailureSummary(failures = []) {
  return failures.map((failure, index) => {
    const parts = [];
    if (failure.modelId) parts.push(`model:${failure.modelId}`);
    if (failure.errorCode) parts.push(`code:${failure.errorCode}`);
    if (failure.errorName) parts.push(`error:${failure.errorName}`);
    if (failure.statusCode) parts.push(`http:${failure.statusCode}`);
    return `[${index + 1}] ${parts.join(' ')}`;
  }).join('; ') || 'none';
}

export class PaidFallbackController {
  constructor(configPath = './config/free-first-config.json', {
    cwd = process.cwd(),
    logPath,
    statePath
  } = {}) {
    this.configPath = resolve(configPath);
    this.cwd = cwd;
    this.config = null;
    this.logPathOverride = logPath;
    this.statePathOverride = statePath;
    this.logPath = null;
    this.statePath = null;
    this._callCounts = new Map();
    this._globalCallCount = 0;
    this._stateLoaded = false;
  }

  async _loadConfig() {
    if (this.config) return this.config;
    this.config = JSON.parse(readFileSync(this.configPath, 'utf8'));
    const general = this.config.general || {};
    this.logPath = process.env.AGENT_LOOP_PAID_FALLBACK_LOG_PATH || this.logPathOverride || resolve(
      this.cwd,
      general.paid_fallback_log_path || '.opencode/agent-loop-state/paid-escalations.jsonl'
    );
    this.statePath = process.env.AGENT_LOOP_PAID_FALLBACK_STATE_PATH || this.statePathOverride || resolve(
      this.cwd,
      general.paid_fallback_state_path || '.opencode/agent-loop-state/paid-fallback-state.json'
    );
    this._loadState();
    return this.config;
  }

  _loadState() {
    if (this._stateLoaded || !this.statePath) return;
    const state = readState(this.statePath);
    this._globalCallCount = state.globalCallCount;
    this._callCounts = state.taskCallCounts;
    this._stateLoaded = true;
  }

  _saveState() {
    if (!this.statePath) return;
    atomicWriteJson(this.statePath, {
      version: PAID_STATE_VERSION,
      savedAt: new Date().toISOString(),
      globalCallCount: this._globalCallCount,
      taskCallCounts: Object.fromEntries(this._callCounts)
    });
  }

  async isPaidFallbackAllowed(role) {
    const config = await this._loadConfig();
    const general = config.general || {};
    return general.allow_paid_fallback === true &&
      Array.isArray(general.paid_fallback_allowed_roles) &&
      general.paid_fallback_allowed_roles.includes(role);
  }

  async logEscalation({ taskId, role, freeModelsAttempted, failures, paidModelSelected, result }) {
    await this._loadConfig();
    const entry = {
      timestamp: new Date().toISOString(),
      taskId,
      role,
      freeModelsAttempted,
      failuresSummary: sanitizeFailureSummary(failures),
      paidModelSelected,
      result
    };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    await this.recordPaidCall(taskId);
  }

  async getCallCount(taskId) {
    await this._loadConfig();
    return this._callCounts.get(taskId) || 0;
  }

  async incrementCallCount(taskId) {
    await this._loadConfig();
    const next = (this._callCounts.get(taskId) || 0) + 1;
    this._callCounts.set(taskId, next);
    this._saveState();
    return next;
  }

  async isCallAllowed(taskId, role, options = {}) {
    const config = await this._loadConfig();
    const general = config.general || {};
    if (!await this.isPaidFallbackAllowed(role)) {
      return { allowed: false, reason: `Paid fallback not allowed for role "${role}"` };
    }

    const maxCalls = general.paid_fallback_max_calls_per_task ?? 1;
    const currentCount = await this.getCallCount(taskId);
    if (currentCount >= maxCalls) {
      return { allowed: false, reason: `Paid fallback call limit (${maxCalls}) reached for task "${taskId}"` };
    }

    const globalMaxCalls = general.paid_fallback_max_calls_global;
    if (Number.isInteger(globalMaxCalls) && this._globalCallCount >= globalMaxCalls) {
      return { allowed: false, reason: `Global paid fallback call limit (${globalMaxCalls}) reached` };
    }

    if (general.paid_fallback_requires_approval === true && options.approved !== true) {
      return { allowed: false, reason: 'Paid fallback requires explicit approval' };
    }

    return { allowed: true };
  }

  async recordPaidCall(taskId) {
    await this._loadConfig();
    this._globalCallCount += 1;
    const next = (this._callCounts.get(taskId) || 0) + 1;
    this._callCounts.set(taskId, next);
    this._saveState();
    return next;
  }
}
