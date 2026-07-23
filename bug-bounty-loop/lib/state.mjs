import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function slugify(value, fallback = 'case') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function createCaseId(objective) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const entropy = crypto.randomBytes(3).toString('hex');
  return `${slugify(objective)}-${timestamp}-${entropy}`;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function createCase(workspace, objective, manifestPath, requestedCaseId) {
  const caseId = requestedCaseId ? slugify(requestedCaseId) : createCaseId(objective);
  const root = path.resolve(workspace, '.bounty-loop');
  const caseDir = path.join(root, 'cases', caseId);
  await ensureDir(path.join(caseDir, 'candidates'));
  await ensureDir(path.join(caseDir, 'evidence'));
  await ensureDir(path.join(caseDir, 'reports'));
  const state = {
    schema_version: 1,
    case_id: caseId,
    objective,
    manifest_path: path.resolve(manifestPath),
    status: 'CREATED',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    candidates: [],
    human_approvals: [],
  };
  await writeJsonAtomic(path.join(caseDir, 'state.json'), state);
  return { caseId, caseDir, state };
}

export async function updateCaseState(caseDir, updater) {
  const statePath = path.join(caseDir, 'state.json');
  const state = await readJson(statePath);
  const updated = await updater(structuredClone(state));
  updated.updated_at = new Date().toISOString();
  await writeJsonAtomic(statePath, updated);
  return updated;
}

export async function recordEvent(caseDir, type, details = {}) {
  await appendJsonLine(path.join(caseDir, 'events.jsonl'), {
    at: new Date().toISOString(),
    type,
    ...details,
  });
}
