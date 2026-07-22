import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const EVENT_SCHEMA_VERSION = '1.0.0';

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i;
const VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)[^\s]+/gi
];

export function redactSensitive(value, key = '') {
  if (SECRET_KEY.test(String(key))) return '[REDACTED]';
  if (typeof value === 'string') {
    let output = value;
    for (const pattern of VALUE_PATTERNS) output = output.replace(pattern, match => match.includes('=') ? `${match.split('=')[0]}=[REDACTED]` : '[REDACTED]');
    return output.length > 16000 ? `${output.slice(0, 16000)}…[TRUNCATED]` : output;
  }
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]));
  }
  return value;
}

export function createAgentLoopEvent({ type, taskId, stage, role, modelId, data = {}, timestamp = new Date().toISOString() } = {}) {
  if (!type) throw new Error('Event type is required');
  if (!taskId) throw new Error('Event taskId is required');
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp,
    type,
    taskId,
    ...(stage ? { stage } : {}),
    ...(role ? { role } : {}),
    ...(modelId ? { modelId } : {}),
    data: redactSensitive(data)
  };
}

export function defaultEventLogPath(cwd = process.cwd(), configuredPath = '.opencode/agent-loop-state/events.jsonl') {
  return process.env.AGENT_LOOP_EVENT_LOG_PATH || resolve(cwd, configuredPath);
}

export class AgentLoopEventLogger {
  constructor({ taskId, cwd = process.cwd(), path = defaultEventLogPath(cwd), enabled = true } = {}) {
    if (!taskId) throw new Error('AgentLoopEventLogger requires taskId');
    this.taskId = taskId;
    this.path = path;
    this.enabled = enabled !== false;
    if (this.enabled) mkdirSync(dirname(path), { recursive: true });
  }

  emit(type, details = {}) {
    const event = createAgentLoopEvent({ type, taskId: this.taskId, ...details });
    if (this.enabled) appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }

  query({ type, stage, role, modelId, limit = 200 } = {}) {
    if (!this.enabled) return [];
    let lines = [];
    try { lines = readFileSync(this.path, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.taskId !== this.taskId) continue;
        if (type && event.type !== type) continue;
        if (stage && event.stage !== stage) continue;
        if (role && event.role !== role) continue;
        if (modelId && event.modelId !== modelId) continue;
        events.push(event);
      } catch {}
    }
    return events.slice(-Math.max(1, Math.min(limit, 5000)));
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
