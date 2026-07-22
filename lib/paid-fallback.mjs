import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const PAID_STATE_VERSION = 2;
const DEFAULT_GLOBAL_WINDOW_MINUTES = 24 * 60;
const DEFAULT_TASK_STATE_TTL_MINUTES = 24 * 60;

function safeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function emptyState(now = Date.now()) {
  return {
    globalCallCount: 0,
    globalWindowStartedAtMs: now,
    taskCallState: new Map()
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function normalizeTaskState(value, now) {
  if (typeof value === 'number') {
    return { count: safeInteger(value), updatedAtMs: now };
  }
  return {
    count: safeInteger(value?.count),
    updatedAtMs: safeInteger(value?.updatedAtMs, now)
  };
}

function readState(path, now = Date.now()) {
  if (!existsSync(path)) return emptyState(now);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.version !== 1 && parsed.version !== PAID_STATE_VERSION) return emptyState(now);
    const rawTasks = parsed.taskCallState || parsed.taskCallCounts || {};
    return {
      globalCallCount: safeInteger(parsed.globalCallCount),
      globalWindowStartedAtMs: safeInteger(parsed.globalWindowStartedAtMs, now),
      taskCallState: new Map(
        Object.entries(rawTasks).map(([taskId, value]) => [taskId, normalizeTaskState(value, now)])
      )
    };
  } catch {
    return emptyState(now);
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
    statePath,
    now = () => Date.now()
  } = {}) {
    this.configPath = resolve(configPath);
    this.cwd = cwd;
    this.config = null;
    this.logPathOverride = logPath;
    this.statePathOverride = statePath;
    this.logPath = null;
    this.statePath = null;
    this._globalCallCount = 0;
    this._globalWindowStartedAtMs = 0;
    this._taskCallState = new Map();
    this._globalWindowMs = DEFAULT_GLOBAL_WINDOW_MINUTES * 60 * 1000;
    this._taskStateTtlMs = DEFAULT_TASK_STATE_TTL_MINUTES * 60 * 1000;
    this._stateLoaded = false;
    this._now = now;
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
    this._globalWindowMs = positiveInteger(
      general.paid_fallback_global_window_minutes,
      DEFAULT_GLOBAL_WINDOW_MINUTES
    ) * 60 * 1000;
    this._taskStateTtlMs = positiveInteger(
      general.paid_fallback_task_state_ttl_minutes,
      DEFAULT_TASK_STATE_TTL_MINUTES
    ) * 60 * 1000;
    this._loadState();
    return this.config;
  }

  _loadState() {
    if (this._stateLoaded || !this.statePath) return;
    const now = this._now();
    const state = readState(this.statePath, now);
    this._globalCallCount = state.globalCallCount;
    this._globalWindowStartedAtMs = state.globalWindowStartedAtMs;
    this._taskCallState = state.taskCallState;
    this._stateLoaded = true;
    if (this._refreshWindows(now)) this._saveState();
  }

  _refreshWindows(now = this._now()) {
    let changed = false;
    if (now - this._globalWindowStartedAtMs >= this._globalWindowMs) {
      this._globalCallCount = 0;
      this._globalWindowStartedAtMs = now;
      changed = true;
    }
    for (const [taskId, state] of this._taskCallState) {
      if (now - state.updatedAtMs >= this._taskStateTtlMs) {
        this._taskCallState.delete(taskId);
        changed = true;
      }
    }
    return changed;
  }

  _saveState() {
    if (!this.statePath) return;
    atomicWriteJson(this.statePath, {
      version: PAID_STATE_VERSION,
      savedAt: new Date(this._now()).toISOString(),
      globalCallCount: this._globalCallCount,
      globalWindowStartedAtMs: this._globalWindowStartedAtMs,
      taskCallState: Object.fromEntries(this._taskCallState)
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
      timestamp: new Date(this._now()).toISOString(),
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
    if (this._refreshWindows()) this._saveState();
    return this._taskCallState.get(taskId)?.count || 0;
  }

  async incrementCallCount(taskId) {
    await this._loadConfig();
    const now = this._now();
    this._refreshWindows(now);
    const next = (this._taskCallState.get(taskId)?.count || 0) + 1;
    this._taskCallState.set(taskId, { count: next, updatedAtMs: now });
    this._saveState();
    return next;
  }

  async isCallAllowed(taskId, role, options = {}) {
    const config = await this._loadConfig();
    const general = config.general || {};
    if (this._refreshWindows()) this._saveState();
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
      return {
        allowed: false,
        reason: `Global paid fallback call limit (${globalMaxCalls}) reached for the current ${Math.round(this._globalWindowMs / 60000)}-minute window`
      };
    }

    if (general.paid_fallback_requires_approval === true && options.approved !== true) {
      return { allowed: false, reason: 'Paid fallback requires explicit approval' };
    }

    return { allowed: true };
  }

  async recordPaidCall(taskId) {
    await this._loadConfig();
    const now = this._now();
    this._refreshWindows(now);
    this._globalCallCount += 1;
    const next = (this._taskCallState.get(taskId)?.count || 0) + 1;
    this._taskCallState.set(taskId, { count: next, updatedAtMs: now });
    this._saveState();
    return next;
  }
}
