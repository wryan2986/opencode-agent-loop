import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Configuration defaults
const DEFAULT_TIMEOUT_MS = 90000; // 90 seconds per task
const DEFAULT_STALL_TIMEOUT_MS = 120000; // 120s stall detection (above source-mode first-event/provider timeouts)
const DEFAULT_RUNS = 3;
const DEFAULT_CONCURRENCY = 1; // Serial execution
const DEFAULT_AGENT = 'build';
const DEFAULT_BINARY = '/home/casaos/.opencode/bin/opencode';

// ---------------------------------------------------------------------------
// Executable resolution (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenCode executable configuration.
 *
 * Priority (highest first):
 * 1. CLI --executable <path>        → binary mode at explicit path
 * 2. CLI --source <dir>             → source mode (bun run --conditions=browser src/index.ts in <dir>)
 * 3. AGENT_LOOP_WORKER_EXECUTABLE   → binary path, or JSON config object
 * 4. AGENT_LOOP_WORKER_SOURCE_DIR   → source mode via env var
 * 5. DEFAULT_BINARY                  → /home/casaos/.opencode/bin/opencode
 *
 * Returns { executable, prefixArgs, cwd, label, mode } where:
 *   - executable: string path to the binary/runtime
 *   - prefixArgs: array of args to insert before the opencode subcommand args
 *   - cwd: working directory for spawn (or null for default)
 *   - label: human-readable description for diagnostics
 *   - mode: 'binary' | 'source'
 *
 * Throws if the resolved executable does not exist on disk.
 */
export function resolveOpencodeConfig(opts = {}) {
  const { executable: cliExecutable, sourceDir: cliSource } = opts;

  // --- Determine mode and raw values ---
  let executable;
  let sourceDir;
  let prefixArgs = [];
  let cwd = null;
  let mode = 'binary';
  let label = '';

  if (cliExecutable) {
    // CLI --executable overrides everything
    executable = cliExecutable;
    mode = 'binary';
    label = `CLI --executable ${executable}`;
  } else if (cliSource) {
    // CLI --source triggers source mode
    sourceDir = cliSource;
    mode = 'source';
    label = `CLI --source ${sourceDir}`;
  } else if (process.env.AGENT_LOOP_WORKER_EXECUTABLE) {
    const envVal = process.env.AGENT_LOOP_WORKER_EXECUTABLE.trim();
    // Allow a JSON config object for maximum flexibility
    if (envVal.startsWith('{')) {
      try {
        const cfg = JSON.parse(envVal);
        executable = cfg.executable;
        prefixArgs = cfg.args || [];
        sourceDir = cfg.sourceDir || null;
        cwd = cfg.cwd || null;
        mode = cfg.sourceDir ? 'source' : (prefixArgs.length > 0 ? 'source' : 'binary');
        label = `env AGENT_LOOP_WORKER_EXECUTABLE JSON — executable=${executable} prefixArgs=[${prefixArgs.join(', ')}] cwd=${cwd || '(none)'}`;
      } catch (e) {
        throw new Error(`AGENT_LOOP_WORKER_EXECUTABLE is invalid JSON: ${e.message}`);
      }
    } else {
      executable = envVal;
      mode = 'binary';
      label = `env AGENT_LOOP_WORKER_EXECUTABLE=${executable}`;
    }
  } else if (process.env.AGENT_LOOP_WORKER_SOURCE_DIR) {
    sourceDir = process.env.AGENT_LOOP_WORKER_SOURCE_DIR.trim();
    mode = 'source';
    label = `env AGENT_LOOP_WORKER_SOURCE_DIR=${sourceDir}`;
  } else {
    executable = DEFAULT_BINARY;
    mode = 'binary';
    label = `default binary ${executable}`;
  }

  // --- Source mode: resolve to bun + prefix args ---
  if (mode === 'source') {
    if (!sourceDir) {
      throw new Error('Source mode requires AGENT_LOOP_WORKER_SOURCE_DIR or --source <dir>');
    }
    if (!existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }
    const indexPath = resolve(sourceDir, 'src', 'index.ts');
    if (!existsSync(indexPath)) {
      throw new Error(`Source entry point not found: ${indexPath}`);
    }
    executable = 'bun';
    prefixArgs = ['run', '--conditions=browser', 'src/index.ts'];
    cwd = sourceDir;
    label = `${label} → source mode (bun run --conditions=browser src/index.ts) in ${sourceDir}`;
  }

  // --- Binary mode: validate executable exists ---
  if (mode === 'binary') {
    if (!existsSync(executable)) {
      throw new Error(`OpenCode executable not found: ${executable}\nSet AGENT_LOOP_WORKER_EXECUTABLE or use --executable <path> to specify the correct path.`);
    }
    label = `${label} → binary ${executable}`;
  }

  return { executable, prefixArgs, cwd, label, mode };
}

// Lazily resolved config cache (resolved once at module load for back-compat)
let _resolvedConfig = null;
function getConfig() {
  if (!_resolvedConfig) {
    _resolvedConfig = resolveOpencodeConfig();
  }
  return _resolvedConfig;
}

const MODELS = [
  'rx580-qwythos/qwythos-9b-local',
  'rx580-smollm3/smollm3-3b-local',
  'rx580-qwen3/qwen3-4b-local',
  'rx580-llama32/llama32-3b-local'
];

// ---------------------------------------------------------------------------
// 24 bounded scoreable tasks — exploration, test/log, escalation, mechanics
// ---------------------------------------------------------------------------
const TASKS = {
  // Exploration tasks (6 tasks)
  exploration: [
    { id: 'explore-basic',     prompt: 'List the files in the current directory using the bash tool.' },
    { id: 'explore-readme',    prompt: 'Read the README.md file and summarize its contents.' },
    { id: 'explore-config',    prompt: 'Read the package.json file and identify the project name and version.' },
    { id: 'explore-tests',     prompt: 'List all test files in the tests directory.' },
    { id: 'explore-docs',      prompt: 'Read the opencode.json configuration file and identify the agent configuration.' },
    { id: 'explore-structure', prompt: 'Describe the overall project structure based on what you can discover.' }
  ],

  // Test/log interpretation tasks (6 tasks)
  tests_logs: [
    { id: 'test-basic-response', prompt: 'Reply with exactly MODEL_READY.' },
    { id: 'test-bash-tool',      prompt: 'Use the bash tool to run `ls -la`, then return the exact directory path.' },
    { id: 'test-read-file',      prompt: 'Use repository tools to read package.json and return only the package name.' },
    { id: 'test-write-read',     prompt: 'Create a file called "benchmark-test.txt" with content "test passed", read it back, and confirm.' },
    { id: 'test-multi-step',     prompt: 'Inspect the repository, create a directory "benchmark-output", list its contents, then delete it.' },
    { id: 'test-logging',        prompt: 'Write a log entry to a file called "benchmark.log" with timestamp, then read it back.' }
  ],

  // Escalation tasks (6 tasks)
  escalation: [
    { id: 'escalate-error',      prompt: 'Generate a syntax error in a JavaScript file, catch it, and report the error message.' },
    { id: 'escalate-timeout',    prompt: 'Start a long-running process (sleep 10 seconds), then interrupt it after 2 seconds.' },
    { id: 'escalate-permission', prompt: 'Attempt to write to a read-only file, handle the error gracefully, and report the issue.' },
    { id: 'escalate-missing',    prompt: 'Attempt to read a non-existent file, handle the error, and provide a helpful message.' },
    { id: 'escalate-memory',     prompt: 'Create a large array (10000 elements), process it, then free the memory.' },
    { id: 'escalate-exception',  prompt: 'Throw an exception with a custom error message, catch it, and log the stack trace.' }
  ],

  // One-file mechanical edits (6 tasks)
  mechanical_edits: [
    { id: 'edit-add-comment',     prompt: 'Add a comment at the top of package.json: "// Benchmark test - do not remove"' },
    { id: 'edit-modify-version',  prompt: 'Increment the version field in package.json by 0.0.1 (e.g., 1.0.0 -> 1.0.1).' },
    { id: 'edit-add-property',    prompt: 'Add a new property "benchmark": true to package.json.' },
    { id: 'edit-remove-comment',  prompt: 'Remove the comment you just added from package.json.' },
    { id: 'edit-rename-file',     prompt: 'Rename package.json to package-benchmark.json temporarily, then rename it back.' },
    { id: 'edit-restore-file',    prompt: 'Create a backup of package.json, modify it, then restore from backup.' }
  ]
};

const BASELINE_FILES = {
  'package.json': JSON.stringify({
    name: 'benchmark-test-fixture',
    version: '1.0.0',
    description: 'Temporary fixture for model benchmarking'
  }, null, 2),
  'README.md': '# Benchmark Fixture\n\nThis is a temporary directory for model benchmarking tests.',
  'opencode.json': JSON.stringify({
    $schema: 'https://opencode.ai/config.json'
  }, null, 2)
};

function textIncludes(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function changedIncludes(changedFiles, file) {
  return changedFiles.includes(file);
}

const EXPECTED_OUTCOMES = {
  'explore-basic': {
    description: 'Directory listing evidence includes fixture files',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => ['package.json', 'README.md', 'opencode.json'].every(f => allOutput.includes(f))
  },
  'explore-readme': {
    description: 'README content is read and summarized',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => textIncludes(allOutput, 'Benchmark Fixture') && textIncludes(allOutput, 'temporary directory')
  },
  'explore-config': {
    description: 'package.json name and version are identified',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => allOutput.includes('benchmark-test-fixture') && allOutput.includes('1.0.0')
  },
  'explore-tests': {
    description: 'tests directory absence is objectively reported in disposable fixture',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => /tests?.*(no such|not found|missing|does not exist|absent)|no tests? directory/i.test(allOutput)
  },
  'explore-docs': {
    description: 'opencode.json schema configuration is identified',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => allOutput.includes('opencode.json') && allOutput.includes('https://opencode.ai/config.json')
  },
  'explore-structure': {
    description: 'Fixture structure is described from discovered files',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => ['package.json', 'README.md', 'opencode.json'].filter(f => allOutput.includes(f)).length >= 2
  },
  'test-basic-response': {
    description: 'Exact readiness token returned',
    allowedFiles: [],
    requiresTool: false,
    check: ({ text }) => text.trim() === 'MODEL_READY'
  },
  'test-bash-tool': {
    description: 'Bash pwd/listing evidence identifies the fixture path',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput, dir }) => allOutput.includes(dir)
  },
  'test-read-file': {
    description: 'package.json is read and package name returned',
    allowedFiles: [],
    requiresTool: true,
    check: ({ text, allOutput }) => text.trim() === 'benchmark-test-fixture' || allOutput.includes('benchmark-test-fixture')
  },
  'test-write-read': {
    description: 'benchmark-test.txt exists with expected contents',
    allowedFiles: ['benchmark-test.txt'],
    requiresTool: true,
    check: ({ dir, changedFiles }) => changedIncludes(changedFiles, 'benchmark-test.txt') && readFileIfExists(resolve(dir, 'benchmark-test.txt')).trim() === 'test passed'
  },
  'test-multi-step': {
    description: 'Temporary benchmark-output directory was created and removed',
    allowedFiles: ['benchmark-output'],
    requiresTool: true,
    check: ({ allOutput, changedFiles, dir }) => !existsSync(resolve(dir, 'benchmark-output')) && (changedIncludes(changedFiles, 'benchmark-output') || textIncludes(allOutput, 'benchmark-output'))
  },
  'test-logging': {
    description: 'benchmark.log exists and contains a timestamp-like log entry',
    allowedFiles: ['benchmark.log'],
    requiresTool: true,
    check: ({ dir, changedFiles }) => changedIncludes(changedFiles, 'benchmark.log') && /\d{4}|\d{2}:\d{2}|timestamp/i.test(readFileIfExists(resolve(dir, 'benchmark.log')))
  },
  'escalate-error': {
    description: 'Syntax error is generated/caught and reported',
    allowedFiles: ['syntax-error.js'],
    requiresTool: true,
    check: ({ allOutput }) => /syntax(error)?|unexpected token|parse/i.test(allOutput) && /catch|caught|handled|error/i.test(allOutput)
  },
  'escalate-timeout': {
    description: 'Long-running sleep is interrupted or timeout is reported',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => /sleep|timeout|interrupt|killed|terminated|2 seconds|2s/i.test(allOutput)
  },
  'escalate-permission': {
    description: 'Read-only write failure is attempted and handled',
    allowedFiles: ['readonly.txt'],
    requiresTool: true,
    check: ({ allOutput }) => /permission|read-only|readonly|denied|eacces|operation not permitted/i.test(allOutput) && /handle|handled|gracefully|error|failed/i.test(allOutput)
  },
  'escalate-missing': {
    description: 'Missing file read failure is reported helpfully',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => /no such file|not found|non-existent|missing|enoent/i.test(allOutput)
  },
  'escalate-memory': {
    description: 'Large 10000 element array is created/processed/freed or scoped',
    allowedFiles: [],
    requiresTool: true,
    check: ({ allOutput }) => /10000|10,000/.test(allOutput) && /array|elements|processed|memory|free|freed|gc/i.test(allOutput)
  },
  'escalate-exception': {
    description: 'Custom exception is thrown/caught and stack trace logged',
    allowedFiles: ['exception-test.js'],
    requiresTool: true,
    check: ({ allOutput }) => /exception|error/i.test(allOutput) && /stack|at .*\(|trace|caught|throw/i.test(allOutput)
  },
  'edit-add-comment': {
    description: 'package.json has requested leading comment',
    allowedFiles: ['package.json'],
    requiresTool: true,
    check: ({ dir, changedFiles }) => changedIncludes(changedFiles, 'package.json') && readFileIfExists(resolve(dir, 'package.json')).startsWith('// Benchmark test - do not remove')
  },
  'edit-modify-version': {
    description: 'package.json version is incremented to 1.0.1',
    allowedFiles: ['package.json'],
    requiresTool: true,
    check: ({ dir, changedFiles }) => changedIncludes(changedFiles, 'package.json') && /"version"\s*:\s*"1\.0\.1"/.test(readFileIfExists(resolve(dir, 'package.json')))
  },
  'edit-add-property': {
    description: 'package.json includes benchmark true property',
    allowedFiles: ['package.json'],
    requiresTool: true,
    check: ({ dir, changedFiles }) => changedIncludes(changedFiles, 'package.json') && /"benchmark"\s*:\s*true/.test(readFileIfExists(resolve(dir, 'package.json')))
  },
  'edit-remove-comment': {
    description: 'package.json does not contain benchmark comment after removal',
    allowedFiles: ['package.json'],
    requiresTool: true,
    check: ({ dir, changedFiles, allOutput }) => changedIncludes(changedFiles, 'package.json') && !readFileIfExists(resolve(dir, 'package.json')).includes('// Benchmark test - do not remove') && /remove|removed|comment/i.test(allOutput)
  },
  'edit-rename-file': {
    description: 'package.json was renamed away and back without final loss',
    allowedFiles: ['package.json', 'package-benchmark.json'],
    requiresTool: true,
    check: ({ dir, allOutput, changedFiles }) => existsSync(resolve(dir, 'package.json')) && !existsSync(resolve(dir, 'package-benchmark.json')) && (changedIncludes(changedFiles, 'package-benchmark.json') || /package-benchmark\.json|rename|renamed|mv /i.test(allOutput))
  },
  'edit-restore-file': {
    description: 'package.json was backed up/modified/restored to baseline',
    allowedFiles: ['package.json', 'package.json.bak', 'package-backup.json'],
    requiresTool: true,
    check: ({ dir, allOutput }) => readFileIfExists(resolve(dir, 'package.json')) === BASELINE_FILES['package.json'] && /backup|restore|restored|package.*bak|package-backup/i.test(allOutput)
  }
};

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

export function parseJsonLines(output) {
  return output.trim().split('\n')
    .filter(l => l.startsWith('{'))
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

export function hasToolCall(events) {
  return events.some(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool'));
}

export function getToolResults(events) {
  return events
    .filter(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool'))
    .map(tool => tool.part?.state?.output || tool?.state?.output || '');
}

export function getTextContent(events) {
  return events
    .filter(e => e.type === 'text' || e.part?.type === 'text')
    .map(e => e.part?.text || e.text || '')
    .join('\n');
}

export function getFilesChanged(events) {
  const fileEvents = events.filter(e =>
    e.type === 'tool_use' &&
    (e.name === 'edit' || e.name === 'bash' || e.name === 'create_file' || e.name === 'read_file')
  );
  return fileEvents.map(e => {
    if (e.name === 'edit') {
      return e.part?.input?.file || e.input?.file || 'unknown-file';
    }
    if (e.name === 'bash') {
      const cmd = e.part?.input?.command || e.input?.command || '';
      if (cmd.includes('mv ') || cmd.includes('rename')) {
        return cmd.split(' ').slice(-2).join(' ');
      }
    }
    return 'unknown';
  });
}

export function readFileIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

export function snapshotDirectory(dir) {
  const snapshot = new Map();

  function walk(current) {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.name !== '.opencode')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      const rel = relative(dir, fullPath).split('\\').join('/');
      const stat = statSync(fullPath);
      if (entry.isDirectory()) {
        snapshot.set(rel, { type: 'dir' });
        walk(fullPath);
      } else if (entry.isFile()) {
        snapshot.set(rel, { type: 'file', content: readFileSync(fullPath, 'utf8'), mode: stat.mode });
      } else {
        snapshot.set(rel, { type: 'other', mode: stat.mode });
      }
    }
  }

  walk(dir);
  return snapshot;
}

export function diffSnapshots(before, after) {
  const changed = new Set();
  const allFiles = new Set([...before.keys(), ...after.keys()]);
  for (const file of allFiles) {
    const a = before.get(file);
    const b = after.get(file);
    if (!a || !b || a.type !== b.type || a.content !== b.content || a.mode !== b.mode) {
      changed.add(file);
    }
  }
  return [...changed].sort();
}

export function getExpectedOutcome(taskOrId) {
  const id = typeof taskOrId === 'string' ? taskOrId : taskOrId.id;
  return EXPECTED_OUTCOMES[id];
}

export function hasOnlyAllowedChanges(changedFiles = [], allowedFiles = []) {
  const allowed = new Set(allowedFiles);
  return changedFiles.every(file => allowed.has(file) || [...allowed].some(a => file === a || file.startsWith(`${a}/`)));
}

export function classifyCliError({ exitCode, stderr = '', stdout = '', timedOut = false, stalled = false } = {}) {
  if (timedOut) return { errorType: 'timeout', errorMessage: 'Task timed out' };
  if (stalled) return { errorType: 'stall', errorMessage: 'Task stalled with no output' };
  if (exitCode === 0 || exitCode === null || exitCode === undefined) return { errorType: null, errorMessage: '' };

  const combined = `${stderr}\n${stdout}`.trim();
  if (/ENOENT|not found|no such file|spawn .* ENOENT/i.test(combined)) {
    return { errorType: 'cli-unavailable', errorMessage: combined || `CLI exited with code ${exitCode}` };
  }
  if (/connection refused|ECONNREFUSED|unavailable|could not connect|model.*not.*found|provider|service/i.test(combined)) {
    return { errorType: 'service-unavailable', errorMessage: combined || `Service unavailable (exit code ${exitCode})` };
  }
  return { errorType: 'cli-error', errorMessage: combined || `CLI exited with code ${exitCode}` };
}

/**
 * Classify a model response into scoring dimensions.
 * Returns a deterministic analysis object (no randomness).
 */
export function classifyModelResponse(events, expected, taskCategory, context = {}) {
  const expectedOutcome = typeof expected === 'object' ? expected : { description: String(expected), check: ({ allOutput }) => allOutput.includes(String(expected)), allowedFiles: [] };
  const text = getTextContent(events);
  const toolResults = getToolResults(events);
  const filesChanged = context.changedFiles ?? [];
  const allOutput = text + '\n' + toolResults.join('\n');

  // -- Correctness: did the task-specific evidence/action exist?
  let hasCorrectAnswer = false;
  try {
    hasCorrectAnswer = Boolean(expectedOutcome.check?.({ text, toolResults, allOutput, filesChanged, dir: context.dir, runResult: context.runResult }));
  } catch {
    hasCorrectAnswer = false;
  }

  // -- Evidence accuracy: does the response cite specific tool output
  //    rather than hallucinating?  We check that tool result fragments appear
  //    inline in the text response.  Merely having the correct answer without
  //    referencing tool output is correctness, not evidence accuracy.
  const toolCallCount = events.filter(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool')).length;
  const citesToolOutput = toolResults.some(r => r.trim().length > 0 && text.includes(r.slice(0, 30)));
  const evidenceAccuracy = citesToolOutput ? 1 : (toolCallCount >= 1 ? 0.5 : 0);

  // -- False success: claims success without actually doing work
  const hasRequiredToolUse = !expectedOutcome.requiresTool || hasToolCall(events);
  const claimsSuccess = /\b(MODEL_READY|completed|complete|done|success|successful|created|updated|fixed|renamed|restored)\b/i.test(text);
  const isFalseSuccess = claimsSuccess && (!hasRequiredToolUse || !hasCorrectAnswer);

  // -- Unrelated changes: edits outside allowed scope
  const allowedFiles = expectedOutcome.allowedFiles || [];
  const hasOutOfScope = !hasOnlyAllowedChanges(filesChanged, allowedFiles);

  // -- Escalation awareness: error handling verbiage
  const hasErrorHandling = /error|Error:|Exception|failed|unable|cannot/i.test(text);

  return {
    hasCorrectAnswer,
    expectedDescription: expectedOutcome.description,
    evidenceAccuracy,
    isFalseSuccess,
    hasRequiredToolUse,
    hasOutOfScope,
    hasErrorHandling,
    toolCallCount,
    filesChanged,
    responseLength: text.length + toolResults.reduce((sum, r) => sum + r.length, 0),
    allOutput
  };
}

/**
 * Score a single run result into a 0-1 composite and per-dimension breakdown.
 * Scoring is fully deterministic given the same events + expected text.
 */
export function scoreRun(runResult, expectedOutcome, taskCategory) {
  const classification = classifyModelResponse(runResult.events, expectedOutcome, taskCategory, {
    changedFiles: runResult.filesChanged,
    dir: runResult.fixtureDir,
    runResult
  });

  const dims = {
    // Correctness (0-1): had the expected answer
    correctness: 0,
    // Evidence accuracy (0-1): cited tool output
    evidenceAccuracy: 0,
    // False success prevention (0-1): did not claim success without work
    falseSuccess: 1,
    // No unrelated changes (0-1): only touched scoped files
    unrelatedChanges: 1,
    // Escalation handling (0-1): handled errors gracefully
    escalation: 0,
    // Reliability (0-1): completed without timeout or crash
    reliability: 1
  };

  // Reliability
  if (runResult.timedOut) {
    dims.reliability = 0;
  } else if (runResult.unavailable || (runResult.exitCode !== 0 && runResult.exitCode !== null)) {
    dims.reliability = 0.3;
  }

  // False success
  if (classification.isFalseSuccess) {
    dims.falseSuccess = 0;
  }

  // Unrelated changes
  if (classification.hasOutOfScope) {
    dims.unrelatedChanges = 0;
  }

  // Correctness
  if (!runResult.timedOut && classification.hasCorrectAnswer) {
    dims.correctness = 1;
  }

  // Evidence accuracy
  if (!runResult.timedOut) {
    dims.evidenceAccuracy = classification.evidenceAccuracy;
  }

  // Escalation
  if (!runResult.timedOut && classification.hasErrorHandling) {
    dims.escalation = 1;
  } else if (!runResult.timedOut && classification.toolCallCount >= 1) {
    dims.escalation = 0.5;
  }

  // Composite: weighted average
  const weights = {
    correctness: 0.30,
    evidenceAccuracy: 0.20,
    falseSuccess: 0.15,
    unrelatedChanges: 0.10,
    escalation: 0.10,
    reliability: 0.15
  };

  let composite = 0;
  for (const [key, w] of Object.entries(weights)) {
    composite += dims[key] * w;
  }

  // Round to 3 decimals
  composite = Math.round(composite * 1000) / 1000;

  // Determine pass/fail
  let passed = false;
  let reason = '';
  let score = 0;

  if (runResult.timedOut) {
    passed = false;
    reason = 'timeout';
    score = 0;
  } else if (runResult.unavailable) {
    passed = false;
    reason = runResult.errorType || 'unavailable';
    score = 0;
  } else if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
    passed = false;
    reason = `exit code ${runResult.exitCode}`;
    score = 0;
  } else if (classification.isFalseSuccess) {
    passed = false;
    reason = 'false success - no required evidence';
    score = 0;
  } else if (classification.hasOutOfScope) {
    passed = false;
    reason = 'out-of-scope edits detected';
    score = 0;
  } else if (classification.hasCorrectAnswer) {
    passed = true;
    reason = 'correct answer';
    score = 1;
  } else if (classification.hasErrorHandling) {
    passed = false;
    reason = 'error handled but no correct answer';
    score = 0.5;
  } else {
    passed = false;
    reason = 'no correct answer or error handling';
    score = 0.2;
  }

  return {
    score,
    composite,
    passed,
    reason,
    dimensions: dims,
    ...classification
  };
}

// ---------------------------------------------------------------------------
// Argument construction (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Build the CLI arguments array for an opencode benchmark run.
 * Returns a deterministic array of args given the model, task, dir, and agent.
 * The agent defaults to 'build' (bounded worker) instead of the full
 * orchestrator path, avoiding infrastructure stalls.
 */
export function buildTaskArgs(model, task, dir, agent = DEFAULT_AGENT) {
  return ['run', '--model', model, '--agent', agent, '--format', 'json', '--dir', dir, '--auto', task.prompt];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single task with a model via the opencode CLI.
 * Captures: exit code, duration, timeout/stall, tool calls, response,
 * changed files, and throughput metadata.
 *
 * @param {object} [opencodeConfig] — resolved config from resolveOpencodeConfig().
 *   If omitted, uses the globally resolved default.
 */
export async function runTaskWithModel(model, task, dir, timeoutMs = DEFAULT_TIMEOUT_MS, agent = DEFAULT_AGENT, opencodeConfig = null, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS) {
  const cfg = opencodeConfig || getConfig();
  const args = buildTaskArgs(model, task, dir, agent);
  const spawnArgs = [...cfg.prefixArgs, ...args];
  const beforeSnapshot = snapshotDirectory(dir);

  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };
  if (cfg.cwd) spawnOpts.cwd = cfg.cwd;

  const child = spawn(cfg.executable, spawnArgs, spawnOpts);
  child.stdin?.destroy();

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let stalled = false;
  let exitCode = null;
  const startTime = Date.now();

  // Overall task timeout
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!child.killed) child.kill('SIGTERM');
  }, timeoutMs);

  // Stall detector: if no output for >stallTimeoutMs, kill and report stall
  let lastActivity = Date.now();
  const effectiveStallMs = Math.max(stallTimeoutMs, 1000); // minimum 1s guard
  const stallInterval = setInterval(() => {
    if (Date.now() - lastActivity > effectiveStallMs && !child.killed) {
      stalled = true;
      stderr += `\n[STALL] No output for ${effectiveStallMs / 1000}s — killing process\n`;
      if (!child.killed) child.kill('SIGTERM');
    }
  }, 5000);

  child.stdout.on('data', d => {
    stdout += d;
    lastActivity = Date.now();
  });
  child.stderr.on('data', d => {
    stderr += d;
    lastActivity = Date.now();
  });

  await new Promise((resolvePromise) => {
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(stallInterval);
      exitCode = code;
      resolvePromise();
    });
    child.on('error', (e) => {
      clearTimeout(timeout);
      clearInterval(stallInterval);
      stderr += e.message;
      exitCode = -1;
      resolvePromise();
    });
  });

  const elapsedMs = Date.now() - startTime;
  const events = parseJsonLines(stdout);
  const afterSnapshot = snapshotDirectory(dir);
  const filesChanged = diffSnapshots(beforeSnapshot, afterSnapshot);
  const { errorType, errorMessage } = classifyCliError({ exitCode, stderr, stdout, timedOut, stalled });
  const success = !timedOut && !stalled && exitCode === 0;
  const unavailable = exitCode !== 0 && !timedOut && !stalled;

  return {
    success,
    timedOut,
    stalled,
    unavailable,
    errorType,
    errorMessage,
    exitCode,
    elapsedMs,
    stdout,
    stderr,
    events,
    filesChanged,
    fixtureDir: dir
  };
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

export function createFixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-fixture-'));
  for (const [file, contents] of Object.entries(BASELINE_FILES)) {
    writeFileSync(resolve(dir, file), contents);
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

export async function benchmarkModel(model, fixtureDir = null, runs = DEFAULT_RUNS, timeoutMs = DEFAULT_TIMEOUT_MS, agent = DEFAULT_AGENT, opencodeConfig = null, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS) {
  const cfg = opencodeConfig || getConfig();
  const results = [];

  for (let i = 0; i < runs; i++) {
    const runResults = [];
    const runFixtureDir = createFixture();

    try {
      for (const [category, tasks] of Object.entries(TASKS)) {
        for (const task of tasks) {
          const taskId = `${category}-${i}-${task.id}`;
          const expected = getExpectedOutcome(task);

          const result = await runTaskWithModel(model, task, runFixtureDir, timeoutMs, agent, cfg, stallTimeoutMs);
          const scored = scoreRun(result, expected, category);

          runResults.push({
            taskId,
            category,
            expectedOutcome: expected.description,
            allowedFiles: expected.allowedFiles,
            ...result,
            ...scored,
            taskPrompt: task.prompt
          });
        }
      }
    } finally {
      rmSync(runFixtureDir, { recursive: true, force: true });
    }

    results.push(runResults);

    await delay(1000);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateReport(allResults, options = {}) {
  const {
    timestamp = new Date().toISOString(),
    runs = DEFAULT_RUNS,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    agent = DEFAULT_AGENT
  } = options;

  const models = Object.keys(allResults);
  const totalTasks = Object.values(TASKS).reduce((sum, tasks) => sum + tasks.length, 0);
  const totalRuns = runs;
  const totalScoreableTasks = totalTasks * totalRuns * models.length;

  const summary = {
    metadata: {
      timestamp,
      models,
      runs,
      concurrency,
      timeoutMs,
      stallTimeoutMs,
      agent,
      totalModels: models.length,
      totalTasks,
      totalScoreableTasks,
      taskCategories: Object.keys(TASKS)
    },
    models: {}
  };

  for (const model of models) {
    const modelRuns = allResults[model];
    if (!modelRuns || modelRuns.error) {
      summary.models[model] = { error: modelRuns?.error || 'unknown error' };
      continue;
    }

    const modelStats = {
      runs: [],
      totals: {
        successfulRuns: 0,
        failedRuns: 0,
        timedOutRuns: 0,
        stalledRuns: 0,
        unavailableRuns: 0,
        totalScore: 0,
        avgScore: 0,
        avgComposite: 0,
        throughputTasksPerMin: 0,
        totalTimeMs: 0,
        reliability: 0,
        correctnessAvg: 0,
        evidenceAccuracyAvg: 0,
        falseSuccessAvg: 0,
        unrelatedChangesAvg: 0,
        escalationAvg: 0
      },
      tasks: {}
    };

    let totalTimeMs = 0;
    let totalComposite = 0;

    for (let runIdx = 0; runIdx < modelRuns.length; runIdx++) {
      const run = modelRuns[runIdx];
      const runStats = {
        runIndex: runIdx,
        successful: 0,
        failed: 0,
        timedOut: 0,
        stalled: 0,
        unavailable: 0,
        score: 0,
        composite: 0,
        avgTaskScore: 0,
        avgTaskComposite: 0,
        runTimeMs: 0,
        tasks: []
      };

      let runTimeMs = 0;

      for (const task of run) {
        runStats.tasks.push({
          taskId: task.taskId,
          category: task.category,
          expectedOutcome: task.expectedOutcome,
          allowedFiles: task.allowedFiles,
          success: task.passed,
          score: task.score,
          composite: task.composite,
          dimensions: task.dimensions,
          reason: task.reason,
          timedOut: task.timedOut,
          stalled: task.stalled,
          unavailable: task.unavailable,
          errorType: task.errorType,
          errorMessage: task.errorMessage,
          exitCode: task.exitCode,
          elapsedMs: task.elapsedMs,
          toolCallCount: task.toolCallCount,
          filesChanged: task.filesChanged,
          responseLength: task.responseLength
        });

        if (task.passed) runStats.successful++;
        if (task.timedOut) runStats.timedOut++;
        if (task.stalled) runStats.stalled++;
        if (task.unavailable) runStats.unavailable++;
        if (!task.passed && !task.timedOut && !task.stalled && !task.unavailable) runStats.failed++;

        runStats.score += task.score || 0;
        runStats.composite += task.composite || 0;
        runTimeMs += task.elapsedMs || 0;
      }

      runStats.avgTaskScore = run.length > 0 ? runStats.score / run.length : 0;
      runStats.avgTaskComposite = run.length > 0 ? runStats.composite / run.length : 0;
      runStats.runTimeMs = runTimeMs;

      modelStats.runs.push(runStats);

      totalTimeMs += runTimeMs;
      totalComposite += runStats.composite;

      if (runStats.timedOut === 0 && runStats.stalled === 0 && runStats.unavailable === 0) {
        if (runStats.failed === 0) modelStats.totals.successfulRuns++;
        else modelStats.totals.failedRuns++;
      }
      if (runStats.timedOut > 0) modelStats.totals.timedOutRuns++;
      if (runStats.stalled > 0) modelStats.totals.stalledRuns++;
      if (runStats.unavailable > 0) modelStats.totals.unavailableRuns++;

      modelStats.totals.totalScore += runStats.score;
    }

    // Aggregate totals
    const totalTaskInstances = modelRuns.length * totalTasks;
    modelStats.totals.avgScore = totalTaskInstances > 0
      ? Math.round((modelStats.totals.totalScore / totalTaskInstances) * 1000) / 1000
      : 0;
    modelStats.totals.avgComposite = modelRuns.length > 0
      ? Math.round((totalComposite / modelRuns.length) * 1000) / 1000
      : 0;
    modelStats.totals.totalTimeMs = totalTimeMs;
    modelStats.totals.throughputTasksPerMin = totalTimeMs > 0
      ? Math.round((totalTaskInstances / (totalTimeMs / 60000)) * 100) / 100
      : 0;
    modelStats.totals.reliability = modelRuns.length > 0
      ? Math.round((modelStats.totals.successfulRuns / modelRuns.length) * 1000) / 1000
      : 0;

    // Per-dimension averages
    let dimSums = { correctness: 0, evidenceAccuracy: 0, falseSuccess: 0, unrelatedChanges: 0, escalation: 0 };
    let dimCount = 0;
    for (const run of modelRuns) {
      for (const task of run) {
        if (task.dimensions) {
          for (const key of Object.keys(dimSums)) {
            if (typeof task.dimensions[key] === 'number') dimSums[key] += task.dimensions[key];
          }
          dimCount++;
        }
      }
    }
    if (dimCount > 0) {
      modelStats.totals.correctnessAvg = Math.round((dimSums.correctness / dimCount) * 1000) / 1000;
      modelStats.totals.evidenceAccuracyAvg = Math.round((dimSums.evidenceAccuracy / dimCount) * 1000) / 1000;
      modelStats.totals.falseSuccessAvg = Math.round((dimSums.falseSuccess / dimCount) * 1000) / 1000;
      modelStats.totals.unrelatedChangesAvg = Math.round((dimSums.unrelatedChanges / dimCount) * 1000) / 1000;
      modelStats.totals.escalationAvg = Math.round((dimSums.escalation / dimCount) * 1000) / 1000;
    }

    summary.models[model] = modelStats;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function generateMarkdownReport(summary) {
  let md = `# OpenCode Model Benchmark Report\n\n`;
  md += `Generated: ${summary.metadata.timestamp}\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Models Tested | ${summary.metadata.totalModels} |\n`;
  md += `| Total Runs | ${summary.metadata.runs} |\n`;
  md += `| Total Scoreable Tasks | ${summary.metadata.totalScoreableTasks} |\n`;
  md += `| Concurrency | ${summary.metadata.concurrency} |\n`;
  md += `| Task Timeout | ${summary.metadata.timeoutMs}ms |\n`;
  if (summary.metadata.stallTimeoutMs != null) {
    md += `| Stall Timeout | ${summary.metadata.stallTimeoutMs}ms |\n`;
  }
  if (summary.metadata.agent) {
    md += `| Agent | ${summary.metadata.agent} |\n`;
  }
  md += `\n`;

  for (const [model, stats] of Object.entries(summary.models)) {
    if (stats.error) {
      md += `### ${model}\n\n**Error:** ${stats.error}\n\n`;
      continue;
    }

    md += `### ${model}\n\n`;
    md += `**Reliability:** ${(stats.totals.reliability * 100).toFixed(1)}%\n\n`;
    md += `**Throughput:** ${stats.totals.throughputTasksPerMin.toFixed(1)} tasks/min\n\n`;
    md += `**Average Score:** ${stats.totals.avgScore.toFixed(3)}\n`;
    md += `**Average Composite:** ${stats.totals.avgComposite.toFixed(3)}\n\n`;

    md += `#### Dimension Averages\n\n`;
    md += `| Dimension | Score |\n`;
    md += `|-----------|-------|\n`;
    md += `| Correctness | ${stats.totals.correctnessAvg.toFixed(3)} |\n`;
    md += `| Evidence Accuracy | ${stats.totals.evidenceAccuracyAvg.toFixed(3)} |\n`;
    md += `| False Success Prevention | ${stats.totals.falseSuccessAvg.toFixed(3)} |\n`;
    md += `| Unrelated Changes | ${stats.totals.unrelatedChangesAvg.toFixed(3)} |\n`;
    md += `| Escalation | ${stats.totals.escalationAvg.toFixed(3)} |\n\n`;

    md += `#### Run Details\n\n`;
    md += `| Run | Success | Failed | TimedOut | Stalled | Unavail | Score | Composite | Time(ms) |\n`;
    md += `|-----|---------|--------|----------|---------|---------|-------|-----------|----------|\n`;

    for (let i = 0; i < stats.runs.length; i++) {
      const run = stats.runs[i];
      md += `| ${i + 1} | ${run.successful} | ${run.failed} | ${run.timedOut} | ${run.stalled} | ${run.unavailable} | ${run.score.toFixed(2)} | ${run.composite.toFixed(2)} | ${run.runTimeMs} |\n`;
    }

    const errorTasks = stats.runs.flatMap(run => run.tasks.filter(task => task.errorType || task.unavailable));
    if (errorTasks.length > 0) {
      md += `\n#### CLI / Service Errors\n\n`;
      md += `| Task | Type | Exit | Message |\n`;
      md += `|------|------|------|---------|\n`;
      for (const task of errorTasks) {
        const message = String(task.errorMessage || task.reason || '').replace(/\s+/g, ' ').slice(0, 160).replace(/\|/g, '\\|');
        md += `| ${task.taskId} | ${task.errorType || 'unavailable'} | ${task.exitCode ?? ''} | ${message} |\n`;
      }
    }

    md += `\n#### Task Category Breakdown\n\n`;
    md += `| Category | Tasks | Avg Score |\n`;
    md += `|----------|-------|-----------|\n`;

    // Per-category breakdown
    const catStats = {};
    for (const run of stats.runs) {
      for (const task of run.tasks) {
        const cat = task.category;
        if (!catStats[cat]) catStats[cat] = { count: 0, scoreSum: 0 };
        catStats[cat].count++;
        catStats[cat].scoreSum += task.score || 0;
      }
    }
    for (const [cat, cs] of Object.entries(catStats)) {
      md += `| ${cat} | ${cs.count} | ${(cs.scoreSum / cs.count).toFixed(3)} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  const options = {
    runs: DEFAULT_RUNS,
    concurrency: DEFAULT_CONCURRENCY,
    timeout: DEFAULT_TIMEOUT_MS,
    stallTimeout: DEFAULT_STALL_TIMEOUT_MS,
    outputDir: process.env.BENCHMARK_OUTPUT_DIR || resolve(tmpdir(), 'benchmark-output'),
    modelFilter: null,
    agent: DEFAULT_AGENT,
    executable: null,   // --executable <path>
    sourceDir: null,    // --source <dir>
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--runs' && i + 1 < args.length) {
      options.runs = parseInt(args[i + 1], 10) || DEFAULT_RUNS;
      i++;
    } else if (arg === '--concurrency' && i + 1 < args.length) {
      options.concurrency = parseInt(args[i + 1], 10) || DEFAULT_CONCURRENCY;
      i++;
    } else if (arg === '--timeout' && i + 1 < args.length) {
      options.timeout = parseInt(args[i + 1], 10) || DEFAULT_TIMEOUT_MS;
      i++;
    } else if (arg === '--stall-timeout' && i + 1 < args.length) {
      options.stallTimeout = parseInt(args[i + 1], 10) || DEFAULT_STALL_TIMEOUT_MS;
      i++;
    } else if (arg === '--output' && i + 1 < args.length) {
      options.outputDir = args[i + 1];
      i++;
    } else if (arg === '--model' && i + 1 < args.length) {
      options.modelFilter = args[i + 1];
      i++;
    } else if (arg === '--agent' && i + 1 < args.length) {
      options.agent = args[i + 1];
      i++;
    } else if (arg === '--executable' && i + 1 < args.length) {
      options.executable = args[i + 1];
      i++;
    } else if (arg === '--source' && i + 1 < args.length) {
      options.sourceDir = args[i + 1];
      i++;
    }
  }

  if (options.help) {
    console.log(`
OpenCode Model Benchmark Runner

Usage: node tests/benchmark-models.mjs [options]

Options:
  --runs <n>            Number of runs per model (default: ${DEFAULT_RUNS})
  --concurrency <n>     Concurrency level (default: ${DEFAULT_CONCURRENCY}, serial only)
  --timeout <ms>        Per-task timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --stall-timeout <ms>  No-output stall detection in ms (default: ${DEFAULT_STALL_TIMEOUT_MS})
  --output <dir>        Output directory for reports (default: ${options.outputDir})
  --model <id>          Filter to specific model ID
  --agent <name>        Agent name to invoke (default: ${DEFAULT_AGENT})
  --executable <path>   Path to the opencode binary (overrides default and env)
  --source <dir>        Use source checkout via "bun run --conditions=browser src/index.ts" in <dir>
  --help, -h            Show this help message

Environment:
  AGENT_LOOP_WORKER_EXECUTABLE   Path to opencode binary, or JSON config object
  AGENT_LOOP_WORKER_SOURCE_DIR   Source checkout directory (triggers source mode)

Models to benchmark:
  ${MODELS.join('\n  ')}
`);
    process.exit(0);
  }

  // Resolve and validate the opencode executable early
  let opencodeConfig;
  try {
    opencodeConfig = resolveOpencodeConfig({
      executable: options.executable || undefined,
      sourceDir: options.sourceDir || undefined
    });
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Diagnostics: always report selected executable and invocation details
  console.log('=== OpenCode Executable Configuration ===');
  console.log(`  Mode:     ${opencodeConfig.mode}`);
  console.log(`  Label:    ${opencodeConfig.label}`);
  console.log(`  Command:  ${opencodeConfig.executable} ${[...opencodeConfig.prefixArgs, 'run [args..]'].join(' ')}`);
  if (opencodeConfig.cwd) {
    console.log(`  Work dir: ${opencodeConfig.cwd}`);
  }
  console.log('========================================\n');

  const modelsToBenchmark = options.modelFilter
    ? MODELS.filter(m => m.includes(options.modelFilter))
    : MODELS;

  if (modelsToBenchmark.length === 0) {
    console.error(`No models found matching filter: ${options.modelFilter}`);
    process.exit(1);
  }

  console.log(`Starting benchmark with ${options.runs} runs per model, concurrency: ${options.concurrency}, agent: ${options.agent}, stall-timeout: ${options.stallTimeout}ms`);
  console.log(`Models to benchmark: ${modelsToBenchmark.length}`);
  console.log(`Output directory: ${options.outputDir}`);

  if (!existsSync(options.outputDir)) {
    mkdirSync(options.outputDir, { recursive: true });
  }

  const allResults = {};

  for (const model of modelsToBenchmark) {
    console.log(`\n=== Benchmarking model: ${model} ===`);

    try {
      const results = await benchmarkModel(model, null, options.runs, options.timeout, options.agent, opencodeConfig, options.stallTimeout);
      allResults[model] = results;
      console.log(`Completed ${results.length} runs for ${model}`);
    } catch (error) {
      console.error(`Error benchmarking ${model}:`, error.message);
      allResults[model] = { error: error.message };
    }
  }

  // Generate report
  const report = generateReport(allResults, {
    runs: options.runs,
    concurrency: options.concurrency,
    timeoutMs: options.timeout,
    stallTimeoutMs: options.stallTimeout,
    agent: options.agent
  });

  // Inject executable info into report metadata
  report.metadata.executable = {
    mode: opencodeConfig.mode,
    path: opencodeConfig.executable,
    prefixArgs: opencodeConfig.prefixArgs,
    cwd: opencodeConfig.cwd,
    label: opencodeConfig.label
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonReportPath = resolve(options.outputDir, `benchmark-report-${timestamp}.json`);
  const mdReportPath = resolve(options.outputDir, `benchmark-report-${timestamp}.md`);

  writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));
  const mdContent = generateMarkdownReport(report);
  writeFileSync(mdReportPath, mdContent);

  console.log(`\n=== Benchmark Complete ===`);
  console.log(`JSON report: ${jsonReportPath}`);
  console.log(`Markdown report: ${mdReportPath}`);
  console.log(`\nTotal models benchmarked: ${Object.keys(allResults).length}`);

  // Print summary
  let hadFailure = false;
  for (const [model, stats] of Object.entries(report.models)) {
    if (stats.error) {
      console.log(`\n${model}: ERROR — ${stats.error}`);
      hadFailure = true;
      continue;
    }
    console.log(`\n${model}:`);
    console.log(`  Reliability: ${(stats.totals.reliability * 100).toFixed(1)}%`);
    console.log(`  Avg Score: ${stats.totals.avgScore.toFixed(3)}`);
    console.log(`  Throughput: ${stats.totals.throughputTasksPerMin.toFixed(1)} tasks/min`);
    console.log(`  Successful runs: ${stats.totals.successfulRuns}/${report.metadata.runs}`);

    const totalErrors = stats.totals.timedOutRuns + stats.totals.stalledRuns + stats.totals.unavailableRuns;
    if (totalErrors > 0) {
      hadFailure = true;
    }
  }

  if (hadFailure) {
    process.exitCode = 1;
  }
}

// Run main() only when executed directly, not when imported as a module
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}
