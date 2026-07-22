import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const BUDGET_STORE_VERSION = 1;

export function defaultBudgetStatePath(cwd = process.cwd()) {
  return resolve(cwd, '.opencode', 'agent-loop-state', 'budgets.json');
}

function sanitizeLedger(taskId, ledger) {
  if (!taskId || !ledger || typeof ledger !== 'object') return null;
  return {
    taskId,
    createdAtMs: Number(ledger.createdAtMs) || Date.now(),
    updatedAtMs: Number(ledger.updatedAtMs) || Date.now(),
    used: ledger.used || {},
    steps: ledger.steps || {},
    models: ledger.models || {},
    workflowCalls: Number(ledger.workflowCalls) || 0,
    workflowStages: ledger.workflowStages || {},
    exceeded: ledger.exceeded === true,
    exceededReasons: Array.isArray(ledger.exceededReasons) ? ledger.exceededReasons : [],
    unknownPricingModels: Array.isArray(ledger.unknownPricingModels) ? ledger.unknownPricingModels : []
  };
}

export function loadBudgetState(path = defaultBudgetStatePath()) {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.version !== BUDGET_STORE_VERSION || typeof parsed.ledgers !== 'object') return new Map();
    const entries = [];
    for (const [taskId, ledger] of Object.entries(parsed.ledgers)) {
      const sanitized = sanitizeLedger(taskId, ledger);
      if (sanitized) entries.push([taskId, sanitized]);
    }
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export function saveBudgetState(ledgers, path = defaultBudgetStatePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    version: BUDGET_STORE_VERSION,
    savedAt: new Date().toISOString(),
    ledgers: Object.fromEntries([...ledgers.entries()].map(([taskId, ledger]) => [taskId, sanitizeLedger(taskId, ledger)]))
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
