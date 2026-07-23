#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, evaluateUrlScope } from '../lib/manifest.mjs';
import { createCase, ensureDir, readJson, recordEvent, updateCaseState, writeJsonAtomic, slugify } from '../lib/state.mjs';
import { evaluateSubmissionGates } from '../lib/gates.mjs';
import { runOpenCodeAgent } from '../lib/opencode-adapter.mjs';
import { discoveryPrompt, reproductionPrompt, verificationPrompt, impactPrompt, reportPrompt } from '../lib/prompts.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..');

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2).replaceAll('-', '_');
    if (['dry_run', 'json'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[++index];
    if (value === undefined) fail(`--${arg.slice(2)} requires a value`, 2);
    options[key] = value;
  }
  return { command, options };
}

function help() {
  print(`Bug Bounty Validation Loop

Commands:
  init      Create .bounty-loop/program.json and install the scoped HTTP wrapper
  validate  Validate an authorization and scope manifest
  run       Run discovery -> reproduction -> blind verification -> impact -> report draft
  gate      Re-evaluate one saved candidate through deterministic gates
  approve   Record human approval for manual submission; never submits automatically
  status    Show case state

Examples:
  node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" init --workspace .
  node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" validate --workspace .
  node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" run --workspace . --objective "Review account object authorization"
`);
}

function resolveWorkspace(options) {
  return path.resolve(options.workspace || process.cwd());
}

function defaultManifestPath(workspace, options) {
  return path.resolve(options.manifest || path.join(workspace, '.bounty-loop', 'program.json'));
}

async function installTooling(workspace) {
  const toolingDir = path.join(workspace, '.bounty-loop', 'tooling');
  await ensureDir(toolingDir);
  await fs.copyFile(path.join(packageRoot, 'bin', 'bounty-http.mjs'), path.join(toolingDir, 'bounty-http.mjs'));
  await fs.chmod(path.join(toolingDir, 'bounty-http.mjs'), 0o700);
  await ensureDir(path.join(workspace, '.bounty-loop', 'requests'));
}

async function commandInit(options) {
  const workspace = resolveWorkspace(options);
  await ensureDir(path.join(workspace, '.bounty-loop'));
  const destination = defaultManifestPath(workspace, options);
  try {
    await fs.access(destination);
    if (options.force !== 'true') fail(`${destination} already exists. Pass --force true to replace it.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.copyFile(path.join(packageRoot, 'config', 'program.example.json'), destination);
  await installTooling(workspace);
  print({
    status: 'INITIALIZED',
    workspace,
    manifest: destination,
    next: 'Edit the manifest from the current program policy, set authorization.confirmed=true only after review, then run validate.',
  });
}

async function commandValidate(options) {
  const workspace = resolveWorkspace(options);
  const manifestPath = defaultManifestPath(workspace, options);
  const result = await loadManifest(manifestPath, { requireAuthorization: options.allow_unconfirmed !== 'true' });
  print({ status: 'VALID', manifest: result.manifest, path: result.path });
}

function normalizeCandidates(discovery) {
  if (!discovery || !Array.isArray(discovery.candidates)) throw new Error('Discovery output must contain a candidates array');
  return discovery.candidates
    .filter(candidate => candidate && typeof candidate === 'object')
    .map((candidate, index) => ({
      id: slugify(candidate.id || candidate.title || `candidate-${index + 1}`, `candidate-${index + 1}`),
      title: String(candidate.title || `Candidate ${index + 1}`).slice(0, 200),
      url: String(candidate.url || ''),
      method: String(candidate.method || 'GET').toUpperCase(),
      hypothesis: String(candidate.hypothesis || ''),
      preconditions: Array.isArray(candidate.preconditions) ? candidate.preconditions.map(String) : [],
      planned_checks: Array.isArray(candidate.planned_checks) ? candidate.planned_checks.map(String) : [],
      confidence: Number.isFinite(candidate.confidence) ? Math.max(0, Math.min(1, candidate.confidence)) : 0,
    }));
}

async function runStage({ agent, prompt, workspace, caseDir, stage, candidateId, attach }) {
  await recordEvent(caseDir, 'stage_started', { stage, candidate_id: candidateId || null, agent });
  try {
    const result = await runOpenCodeAgent({ agent, prompt, workspace, attach });
    const rawPath = path.join(caseDir, 'evidence', `${candidateId ? `${candidateId}-` : ''}${stage}-raw.txt`);
    await fs.writeFile(rawPath, result.stdout, { mode: 0o600 });
    await recordEvent(caseDir, 'stage_completed', { stage, candidate_id: candidateId || null, agent, raw_path: rawPath });
    return result.parsed;
  } catch (error) {
    const rawPath = path.join(caseDir, 'evidence', `${candidateId ? `${candidateId}-` : ''}${stage}-error.txt`);
    await fs.writeFile(rawPath, `${error.message}\n\nSTDOUT:\n${error.stdout || ''}\n\nSTDERR:\n${error.stderr || ''}`, { mode: 0o600 });
    await recordEvent(caseDir, 'stage_failed', { stage, candidate_id: candidateId || null, agent, error: error.message, raw_path: rawPath });
    throw error;
  }
}

async function commandRun(options) {
  const workspace = resolveWorkspace(options);
  const manifestPath = defaultManifestPath(workspace, options);
  const objective = String(options.objective || options._.join(' ')).trim();
  if (!objective) fail('run requires --objective "..."', 2);
  const maxCandidates = Math.max(1, Math.min(10, Number.parseInt(options.max_candidates || '3', 10)));
  const { manifest } = await loadManifest(manifestPath, { requireAuthorization: true });
  await installTooling(workspace);

  if (options.dry_run) {
    print({
      status: 'DRY_RUN_VALIDATED',
      objective,
      manifest: manifestPath,
      max_candidates: maxCandidates,
      stages: ['discovery', 'reproduction', 'blind_verification', 'impact_review', 'deterministic_gate', 'report_draft', 'human_review'],
    });
    return;
  }

  const { caseId, caseDir } = await createCase(workspace, objective, manifestPath, options.case_id);
  await fs.copyFile(manifestPath, path.join(caseDir, 'manifest.snapshot.json'));
  await updateCaseState(caseDir, state => ({ ...state, status: 'DISCOVERY' }));

  const discovery = await runStage({
    agent: 'bounty-discovery',
    prompt: discoveryPrompt({ objective, manifest, caseDir: path.relative(workspace, caseDir) }),
    workspace,
    caseDir,
    stage: 'discovery',
    attach: options.attach,
  });
  const candidates = normalizeCandidates(discovery).slice(0, maxCandidates);
  await writeJsonAtomic(path.join(caseDir, 'discovery.json'), { candidates });

  const results = [];
  for (const candidate of candidates) {
    const candidateDir = path.join(caseDir, 'candidates', candidate.id);
    await ensureDir(candidateDir);
    await writeJsonAtomic(path.join(candidateDir, 'candidate.json'), candidate);

    const scope = evaluateUrlScope(manifest, candidate.url, candidate.method);
    if (!scope.allowed) {
      const result = { candidate, gate: { passed: false, status: 'QUARANTINED', failures: scope.reasons.map(reason => `scope: ${reason}`) } };
      await writeJsonAtomic(path.join(candidateDir, 'result.json'), result);
      results.push(result);
      continue;
    }

    let reproduction;
    let verification;
    let impact;
    try {
      reproduction = await runStage({
        agent: 'bounty-reproduction',
        prompt: reproductionPrompt({ manifest, candidate, caseDir: path.relative(workspace, caseDir) }),
        workspace,
        caseDir,
        stage: 'reproduction',
        candidateId: candidate.id,
        attach: options.attach,
      });
      await writeJsonAtomic(path.join(candidateDir, 'reproduction.json'), reproduction);

      if (reproduction?.unauthorized_data_observed === true || reproduction?.service_instability_observed === true) {
        await recordEvent(caseDir, 'hard_stop', {
          candidate_id: candidate.id,
          reason: reproduction.unauthorized_data_observed ? 'unauthorized_data_observed' : 'service_instability_observed',
        });
      }

      const blindCandidate = {
        id: candidate.id,
        url: candidate.url,
        method: candidate.method,
        hypothesis: candidate.hypothesis,
        preconditions: candidate.preconditions,
        planned_checks: candidate.planned_checks,
      };
      verification = await runStage({
        agent: 'bounty-verifier',
        prompt: verificationPrompt({
          manifest,
          blindCandidate,
          reproductionEvidence: reproduction?.evidence_refs || [],
          caseDir: path.relative(workspace, caseDir),
        }),
        workspace,
        caseDir,
        stage: 'verification',
        candidateId: candidate.id,
        attach: options.attach,
      });
      await writeJsonAtomic(path.join(candidateDir, 'verification.json'), verification);

      impact = await runStage({
        agent: 'bounty-impact',
        prompt: impactPrompt({ manifest, candidate, reproduction, verification }),
        workspace,
        caseDir,
        stage: 'impact',
        candidateId: candidate.id,
        attach: options.attach,
      });
      await writeJsonAtomic(path.join(candidateDir, 'impact.json'), impact);
    } catch (error) {
      const result = {
        candidate,
        gate: { passed: false, status: 'QUARANTINED', failures: [`stage failure: ${error.message}`] },
      };
      await writeJsonAtomic(path.join(candidateDir, 'result.json'), result);
      results.push(result);
      continue;
    }

    const gate = evaluateSubmissionGates({ manifest, candidate, reproduction, verification, impact });
    const result = { candidate, reproduction, verification, impact, gate };
    if (gate.passed) {
      try {
        const report = await runStage({
          agent: 'bounty-report',
          prompt: reportPrompt({ manifest, candidate, reproduction, verification, impact, gate }),
          workspace,
          caseDir,
          stage: 'report',
          candidateId: candidate.id,
          attach: options.attach,
        });
        if (!report || typeof report.markdown !== 'string' || !report.markdown.trim()) {
          throw new Error('Report agent returned no Markdown report');
        }
        result.report = report;
        await fs.writeFile(path.join(caseDir, 'reports', `${candidate.id}.md`), `${report.markdown.trim()}\n`, { mode: 0o600 });
      } catch (error) {
        result.gate = {
          passed: false,
          status: 'QUARANTINED',
          failures: [...gate.failures, `report generation failed: ${error.message}`],
        };
      }
    }
    await writeJsonAtomic(path.join(candidateDir, 'result.json'), result);
    results.push(result);
  }

  const ready = results.filter(result => result.gate?.status === 'READY_FOR_HUMAN_REVIEW');
  const finalState = await updateCaseState(caseDir, state => ({
    ...state,
    status: ready.length > 0 ? 'READY_FOR_HUMAN_REVIEW' : 'NO_REPORTABLE_FINDINGS',
    candidates: results.map(result => ({
      id: result.candidate.id,
      title: result.candidate.title,
      status: result.gate.status,
      failures: result.gate.failures,
      report: result.report ? path.relative(workspace, path.join(caseDir, 'reports', `${result.candidate.id}.md`)) : null,
    })),
  }));
  await recordEvent(caseDir, 'case_completed', { status: finalState.status, ready_count: ready.length });
  print({
    case_id: caseId,
    status: finalState.status,
    case_dir: path.relative(workspace, caseDir),
    ready_for_human_review: ready.map(result => result.candidate.id),
    quarantined: results.filter(result => result.gate.status !== 'READY_FOR_HUMAN_REVIEW').map(result => result.candidate.id),
    note: 'No report was submitted. Human review and manual submission are required.',
  });
}

async function findCaseDir(workspace, caseId) {
  if (!caseId) fail('--case-id is required', 2);
  const caseDir = path.join(workspace, '.bounty-loop', 'cases', slugify(caseId));
  await fs.access(path.join(caseDir, 'state.json'));
  return caseDir;
}

async function commandStatus(options) {
  const workspace = resolveWorkspace(options);
  const caseDir = await findCaseDir(workspace, options.case_id);
  print(await readJson(path.join(caseDir, 'state.json')));
}

async function commandGate(options) {
  const workspace = resolveWorkspace(options);
  const caseDir = await findCaseDir(workspace, options.case_id);
  if (!options.candidate) fail('--candidate is required', 2);
  const candidateDir = path.join(caseDir, 'candidates', slugify(options.candidate));
  const manifest = await readJson(path.join(caseDir, 'manifest.snapshot.json'));
  const candidate = await readJson(path.join(candidateDir, 'candidate.json'));
  const reproduction = await readJson(path.join(candidateDir, 'reproduction.json'));
  const verification = await readJson(path.join(candidateDir, 'verification.json'));
  const impact = await readJson(path.join(candidateDir, 'impact.json'));
  print(evaluateSubmissionGates({ manifest, candidate, reproduction, verification, impact }));
}

async function commandApprove(options) {
  const workspace = resolveWorkspace(options);
  const caseDir = await findCaseDir(workspace, options.case_id);
  if (!options.candidate) fail('--candidate is required', 2);
  const statement = String(options.statement || '').trim();
  if (statement.length < 20) fail('--statement must record a substantive human review statement', 2);
  const candidateId = slugify(options.candidate);
  const result = await readJson(path.join(caseDir, 'candidates', candidateId, 'result.json'));
  if (result.gate?.status !== 'READY_FOR_HUMAN_REVIEW') {
    fail(`Candidate ${candidateId} is not ready for human review`);
  }
  const state = await updateCaseState(caseDir, current => ({
    ...current,
    status: 'APPROVED_FOR_MANUAL_SUBMISSION',
    human_approvals: [
      ...(current.human_approvals || []),
      {
        candidate_id: candidateId,
        approved_at: new Date().toISOString(),
        statement,
      },
    ],
  }));
  await recordEvent(caseDir, 'human_approval_recorded', { candidate_id: candidateId });
  print({
    status: state.status,
    candidate: candidateId,
    note: 'Approval was recorded locally. The loop does not submit reports or interact with bounty platforms.',
  });
}

const { command, options } = parseArgs(process.argv.slice(2));
try {
  if (command === 'help' || command === '--help' || command === '-h') help();
  else if (command === 'init') await commandInit(options);
  else if (command === 'validate') await commandValidate(options);
  else if (command === 'run') await commandRun(options);
  else if (command === 'gate') await commandGate(options);
  else if (command === 'approve') await commandApprove(options);
  else if (command === 'status') await commandStatus(options);
  else fail(`Unknown command: ${command}`, 2);
} catch (error) {
  fail(error.stack || error.message);
}
