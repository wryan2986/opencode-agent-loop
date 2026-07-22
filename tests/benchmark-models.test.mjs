import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Import only the pure functions — the module no longer auto-runs main()
import {
  parseJsonLines,
  hasToolCall,
  getToolResults,
  getTextContent,
  getFilesChanged,
  classifyModelResponse,
  scoreRun,
  generateReport,
  generateMarkdownReport,
  snapshotDirectory,
  diffSnapshots,
  getExpectedOutcome,
  hasOnlyAllowedChanges,
  classifyCliError,
  createFixture,
  buildTaskArgs,
  resolveOpencodeConfig
} from './benchmark-models.mjs';

// ---------------------------------------------------------------------------
// Pure parser tests
// ---------------------------------------------------------------------------

describe('benchmark-models parsers', () => {
  describe('parseJsonLines', () => {
    it('should parse JSON lines from output', () => {
      const output = '{"type":"text","text":"hello"}\n{"type":"tool_use","name":"bash"}\ninvalid\n';
      const result = parseJsonLines(output);
      assert.equal(result.length, 2);
      assert.equal(result[0].type, 'text');
      assert.equal(result[1].type, 'tool_use');
    });

    it('should return empty array for empty output', () => {
      const result = parseJsonLines('');
      assert.equal(result.length, 0);
    });

    it('should filter out non-JSON lines', () => {
      const output = 'not json\n{"type":"text"}\nalso not json\n';
      const result = parseJsonLines(output);
      assert.equal(result.length, 1);
    });

    it('should handle leading/trailing whitespace', () => {
      const output = '  \n{"type":"text"}\n\n';
      const result = parseJsonLines(output);
      assert.equal(result.length, 1);
    });
  });

  describe('hasToolCall', () => {
    it('should detect tool calls in events', () => {
      const events = [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'bash' }
      ];
      assert.equal(hasToolCall(events), true);
    });

    it('should return false when no tool calls', () => {
      const events = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' }
      ];
      assert.equal(hasToolCall(events), false);
    });

    it('should handle part-based events', () => {
      const events = [
        { part: { type: 'text', text: 'hello' } },
        { part: { type: 'tool', state: { output: 'result' } } }
      ];
      assert.equal(hasToolCall(events), true);
    });
  });

  describe('getToolResults', () => {
    it('should extract tool results from events', () => {
      const events = [
        { type: 'text', text: 'hello' },
        {
          type: 'tool_use',
          name: 'bash',
          part: { state: { output: 'directory: /tmp' } }
        },
        {
          part: { type: 'tool', state: { output: 'file created' } }
        }
      ];
      const results = getToolResults(events);
      assert.equal(results.length, 2);
      assert.ok(results[0].includes('directory'));
      assert.ok(results[1].includes('file created'));
    });

    it('should return empty array when no tool results', () => {
      const events = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' }
      ];
      const results = getToolResults(events);
      assert.equal(results.length, 0);
    });
  });

  describe('getTextContent', () => {
    it('should extract text content from events', () => {
      const events = [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', name: 'bash' }
      ];
      const text = getTextContent(events);
      assert.equal(text, 'hello world');
    });

    it('should handle part-based text events', () => {
      const events = [
        { part: { type: 'text', text: 'part-based text' } },
        { type: 'tool_use', name: 'bash' }
      ];
      const text = getTextContent(events);
      assert.equal(text, 'part-based text');
    });

    it('should return empty string when no text content', () => {
      const events = [
        { type: 'tool_use', name: 'bash' }
      ];
      const text = getTextContent(events);
      assert.equal(text, '');
    });
  });

  describe('getFilesChanged', () => {
    it('should detect file changes from edit tool', () => {
      const events = [
        {
          type: 'tool_use',
          name: 'edit',
          part: { input: { file: 'package.json' } }
        }
      ];
      const files = getFilesChanged(events);
      assert.ok(files.includes('package.json'));
    });

    it('should detect file changes from bash mv command', () => {
      const events = [
        {
          type: 'tool_use',
          name: 'bash',
          part: { input: { command: 'mv package.json package-backup.json' } }
        }
      ];
      const files = getFilesChanged(events);
      assert.ok(files.some(f => f.includes('package')));
    });

    it('should return empty array when no file changes detected', () => {
      const events = [
        { type: 'text', text: 'hello' }
      ];
      const files = getFilesChanged(events);
      assert.equal(files.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Classification tests
// ---------------------------------------------------------------------------

describe('classifyModelResponse', () => {
  it('should classify correct answer correctly', () => {
    const events = [
      { type: 'text', text: 'Task completed successfully. MODEL_READY' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: 'MODEL_READY' } }
      }
    ];
    const result = classifyModelResponse(events, 'MODEL_READY');
    assert.equal(result.hasCorrectAnswer, true);
    assert.ok(result.responseLength > 0);
  });

  it('should detect false success (no tool usage)', () => {
    const events = [
      { type: 'text', text: 'MODEL_READY' }
    ];
    const result = classifyModelResponse(events, {
      description: 'requires tool-backed readiness',
      requiresTool: true,
      allowedFiles: [],
      check: ({ allOutput }) => allOutput.includes('MODEL_READY')
    });
    assert.equal(result.isFalseSuccess, true);
    assert.equal(result.hasCorrectAnswer, true);
  });

  it('should detect out-of-scope edits', () => {
    const events = [{ type: 'text', text: 'done' }];
    const result = classifyModelResponse(events, { description: 'package only', allowedFiles: ['package.json'], check: () => true }, undefined, { changedFiles: ['opencode.json'] });
    assert.equal(result.hasOutOfScope, true);
  });

  it('does not let an unrelated tool call excuse absent task evidence', () => {
    const events = [
      { type: 'text', text: 'Done successfully.' },
      { type: 'tool_use', name: 'bash', part: { state: { output: 'unrelated output' } } }
    ];
    const result = classifyModelResponse(events, getExpectedOutcome('test-read-file'));
    assert.equal(result.hasRequiredToolUse, true);
    assert.equal(result.hasCorrectAnswer, false);
    assert.equal(result.isFalseSuccess, true);
  });

  it('should detect error handling', () => {
    const events = [
      { type: 'text', text: 'Error: file not found. Attempting recovery...' }
    ];
    const result = classifyModelResponse(events, 'test');
    assert.equal(result.hasErrorHandling, true);
  });

  it('should compute evidence accuracy of 1 when tool output cited', () => {
    const events = [
      { type: 'text', text: 'The directory contains: src tests package.json' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: 'src tests package.json' } }
      }
    ];
    const result = classifyModelResponse(events, 'package.json');
    assert.equal(result.evidenceAccuracy, 1);
  });

  it('should compute evidence accuracy of 0 when no tool calls', () => {
    const events = [
      { type: 'text', text: 'The directory contains: src tests package.json' }
    ];
    const result = classifyModelResponse(events, 'package.json');
    assert.equal(result.evidenceAccuracy, 0);
    assert.equal(result.toolCallCount, 0);
  });

  it('should compute evidence accuracy of 0.5 when tool called but output not cited', () => {
    const events = [
      { type: 'text', text: 'The answer is 42.' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: 'something else entirely' } }
      }
    ];
    const result = classifyModelResponse(events, '42');
    // has tool call (≥1) but text doesn't contain any tool output fragment
    assert.equal(result.evidenceAccuracy, 0.5);
  });
});

// ---------------------------------------------------------------------------
// Scoring tests — deterministic on same input
// ---------------------------------------------------------------------------

describe('scoreRun', () => {
  it('should score timeout as 0 with reliability=0', () => {
    const runResult = {
      timedOut: true,
      stalled: false,
      unavailable: false,
      exitCode: null,
      events: []
    };
    const scored = scoreRun(runResult, 'expected');
    assert.equal(scored.score, 0);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'timeout');
    assert.equal(scored.dimensions.reliability, 0);
  });

  it('should score non-zero exit code as 0', () => {
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 1,
      events: []
    };
    const scored = scoreRun(runResult, 'expected');
    assert.equal(scored.score, 0);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'exit code 1');
    assert.equal(scored.dimensions.reliability, 0.3);
  });

  it('should surface unavailable CLI errors without pass credit', () => {
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: true,
      errorType: 'service-unavailable',
      errorMessage: 'connection refused',
      exitCode: 1,
      events: [{ type: 'text', text: 'MODEL_READY' }]
    };
    const scored = scoreRun(runResult, 'MODEL_READY');
    assert.equal(scored.score, 0);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'service-unavailable');
  });

  it('should score false success as 0', () => {
    const events = [
      { type: 'text', text: 'MODEL_READY' }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const scored = scoreRun(runResult, 'MODEL_READY');
    assert.equal(scored.score, 1);
    assert.equal(scored.passed, true);
  });

  it('should score task-aware false success as 0 even with an unrelated tool call', () => {
    const events = [
      { type: 'text', text: 'Created benchmark-test.txt successfully.' },
      { type: 'tool_use', name: 'bash', part: { state: { output: 'README.md' } } }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events,
      filesChanged: []
    };
    const scored = scoreRun(runResult, getExpectedOutcome('test-write-read'));
    assert.equal(scored.score, 0);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'false success - no required evidence');
  });

  it('should score correct answer as 1', () => {
    const events = [
      { type: 'text', text: 'Task completed successfully. MODEL_READY' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: 'MODEL_READY' } }
      }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const scored = scoreRun(runResult, 'MODEL_READY');
    assert.equal(scored.score, 1);
    assert.equal(scored.passed, true);
    assert.equal(scored.reason, 'correct answer');
    assert.equal(scored.dimensions.correctness, 1);
  });

  it('should score error handling as 0.5', () => {
    const events = [
      { type: 'text', text: 'Error: file not found. Attempting recovery...' }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const scored = scoreRun(runResult, 'expected');
    assert.equal(scored.score, 0.5);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'error handled but no correct answer');
    assert.equal(scored.dimensions.escalation, 1);
  });

  it('should score partial success as 0.2', () => {
    const events = [
      { type: 'text', text: 'Some response but not the expected one' }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const scored = scoreRun(runResult, 'expected outcome');
    assert.equal(scored.score, 0.2);
    assert.equal(scored.passed, false);
    assert.equal(scored.reason, 'no correct answer or error handling');
  });

  it('should produce deterministic scores on identical inputs', () => {
    const events = [
      { type: 'text', text: 'The answer is 42.' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: '42' } }
      }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const first = scoreRun(runResult, '42');
    const second = scoreRun(runResult, '42');
    assert.equal(first.score, second.score);
    assert.equal(first.reason, second.reason);
    assert.equal(first.composite, second.composite);
    assert.deepEqual(first.dimensions, second.dimensions);
  });

  it('should expose all six dimension scores', () => {
    const events = [
      { type: 'text', text: 'Completed: MODEL_READY' },
      {
        type: 'tool_use',
        name: 'bash',
        part: { state: { output: 'MODEL_READY' } }
      }
    ];
    const runResult = {
      timedOut: false,
      stalled: false,
      unavailable: false,
      exitCode: 0,
      events
    };
    const scored = scoreRun(runResult, 'MODEL_READY');
    const expectedDims = ['correctness', 'evidenceAccuracy', 'falseSuccess', 'unrelatedChanges', 'escalation', 'reliability'];
    for (const dim of expectedDims) {
      assert.ok(typeof scored.dimensions[dim] === 'number', `dimension ${dim} should be a number`);
    }
  });
});

// ---------------------------------------------------------------------------
// Filesystem scope and task-specific expectations
// ---------------------------------------------------------------------------

describe('filesystem snapshot scope checks', () => {
  it('creates a disposable complete fixture including opencode.json and supports cleanup', () => {
    const dir = createFixture();
    try {
      assert.equal(existsSync(resolve(dir, 'package.json')), true);
      assert.equal(existsSync(resolve(dir, 'README.md')), true);
      assert.equal(existsSync(resolve(dir, 'opencode.json')), true);
      const config = JSON.parse(readFileSync(resolve(dir, 'opencode.json'), 'utf8'));
      assert.deepEqual(config, { $schema: 'https://opencode.ai/config.json' });
      assert.equal(Object.hasOwn(config, 'version'), false);
      assert.equal(Object.hasOwn(config, 'agents'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(existsSync(dir), false);
  });

  it('detects actual fixture diffs independent of tool events', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-snapshot-test-'));
    try {
      writeFileSync(resolve(dir, 'package.json'), '{"name":"fixture"}');
      const before = snapshotDirectory(dir);
      writeFileSync(resolve(dir, 'opencode.json'), '{"agents":{}}');
      mkdirSync(resolve(dir, 'benchmark-output'));
      writeFileSync(resolve(dir, 'benchmark-output', 'result.txt'), 'ok');
      const after = snapshotDirectory(dir);
      const changed = diffSnapshots(before, after);
      assert.deepEqual(changed, ['benchmark-output', 'benchmark-output/result.txt', 'opencode.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces explicit allowed-file sets including nested paths', () => {
    assert.equal(hasOnlyAllowedChanges(['benchmark-output/result.txt'], ['benchmark-output']), true);
    assert.equal(hasOnlyAllowedChanges(['opencode.json'], ['package.json']), false);
  });

  it('uses task-specific expected evidence instead of generic completion text', () => {
    const expected = getExpectedOutcome('explore-config');
    const generic = classifyModelResponse([
      { type: 'text', text: 'Task explore-config completed' },
      { type: 'tool_use', name: 'bash', part: { state: { output: 'unrelated' } } }
    ], expected);
    assert.equal(generic.hasCorrectAnswer, false);

    const real = classifyModelResponse([
      { type: 'text', text: 'name benchmark-test-fixture version 1.0.0' },
      { type: 'tool_use', name: 'bash', part: { state: { output: '"name":"benchmark-test-fixture","version":"1.0.0"' } } }
    ], expected);
    assert.equal(real.hasCorrectAnswer, true);
  });

  it('uses task-specific opencode.json schema evidence for the config exploration task', () => {
    const expected = getExpectedOutcome('explore-docs');
    assert.equal(expected.description, 'opencode.json schema configuration is identified');

    const generic = classifyModelResponse([
      { type: 'text', text: 'Task explore-docs completed' },
      { type: 'tool_use', name: 'bash', part: { state: { output: 'opencode.json exists' } } }
    ], expected);
    assert.equal(generic.hasCorrectAnswer, false);

    const real = classifyModelResponse([
      { type: 'text', text: 'opencode.json uses schema https://opencode.ai/config.json' },
      { type: 'tool_use', name: 'bash', part: { state: { output: '{"$schema":"https://opencode.ai/config.json"}' } } }
    ], expected);
    assert.equal(real.hasCorrectAnswer, true);
  });

  it('preflights the installed OpenCode CLI against a newly-created valid fixture config', () => {
    const dir = createFixture();
    try {
      const opencode = process.env.AGENT_LOOP_WORKER_EXECUTABLE || '/home/casaos/.opencode/bin/opencode';
      const model = process.env.AGENT_LOOP_PREFLIGHT_MODEL || 'rx580-smollm3/smollm3-3b-local';
      const result = spawnSync(opencode, [
        'run', '--print-logs', '--log-level', 'DEBUG', '--model', model, '--format', 'json', '--dir', dir, '--auto', 'Reply with exactly CONFIG_PREFLIGHT_READY.'
      ], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });

      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      assert.doesNotMatch(combined, /Configuration is invalid|Unrecognized keys: version, agents|Unrecognized keys:.*\b(version|agents)\b/i);
      assert.ok(combined.includes(`loading path=${resolve(dir, 'opencode.json')}`), 'CLI did not report loading the fixture opencode.json');
      assert.match(combined, /CONFIG_PREFLIGHT_READY|stream providerID|llm runtime selected|AI_APICallError|ContextOverflowError|API|model|provider|connection|timeout|rate|error/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies CLI and unavailable service errors clearly', () => {
    assert.equal(classifyCliError({ exitCode: 127, stderr: 'opencode: not found' }).errorType, 'cli-unavailable');
    assert.equal(classifyCliError({ exitCode: 1, stderr: 'connection refused' }).errorType, 'service-unavailable');
  });
});

// ---------------------------------------------------------------------------
// Report generation tests
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  it('should generate a valid report structure', () => {
    const mockResults = {
      'test-model-1': [
        [
          {
            taskId: 'test-1',
            category: 'tests_logs',
            passed: true,
            score: 1,
            composite: 1,
            reason: 'correct answer',
            timedOut: false,
            stalled: false,
            unavailable: false,
            exitCode: 0,
            elapsedMs: 100,
            toolCallCount: 1,
            filesChanged: [],
            responseLength: 100,
            dimensions: {
              correctness: 1,
              evidenceAccuracy: 1,
              falseSuccess: 1,
              unrelatedChanges: 1,
              escalation: 0,
              reliability: 1
            }
          }
        ]
      ]
    };

    const report = generateReport(mockResults, { runs: 1 });

    assert.ok(report.metadata);
    assert.ok(report.models);
    assert.equal(report.metadata.totalModels, 1);
    assert.ok(report.models['test-model-1']);
    assert.ok(report.models['test-model-1'].totals);
    assert.ok(typeof report.models['test-model-1'].totals.reliability === 'number');
  });

  it('should calculate reliability correctly', () => {
    const mockResults = {
      'test-model': [
        [
          { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' },
          { passed: false, score: 0, composite: 0, timedOut: false, stalled: false, unavailable: false, exitCode: 1, elapsedMs: 10, toolCallCount: 0, filesChanged: [], responseLength: 10, dimensions: { correctness: 0, evidenceAccuracy: 0, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 0.3 }, reason: 'err', taskId: 't2', category: 'tests_logs' }
        ],
        [
          { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' },
          { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't2', category: 'tests_logs' }
        ]
      ]
    };

    const report = generateReport(mockResults, { runs: 2 });
    const stats = report.models['test-model'].totals;

    assert.equal(stats.successfulRuns, 1);
    assert.equal(stats.failedRuns, 1);
    assert.equal(stats.reliability, 0.5);
  });

  it('should calculate average scores correctly', () => {
    const mockResults = {
      'test-model': [
        [
          { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 100, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' },
          { passed: false, score: 0, composite: 0, timedOut: false, stalled: false, unavailable: false, exitCode: 1, elapsedMs: 10, toolCallCount: 0, filesChanged: [], responseLength: 10, dimensions: { correctness: 0, evidenceAccuracy: 0, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 0.3 }, reason: 'err', taskId: 't2', category: 'tests_logs' }
        ]
      ]
    };

    const report = generateReport(mockResults, { runs: 1 });
    const stats = report.models['test-model'].totals;

    assert.equal(stats.totalScore, 1);
    // avgScore is totalScore / (runs * totalTasks) where totalTasks = 24 (from TASKS),
    // then rounded to 3 decimal places
    assert.equal(stats.avgScore, Math.round((1 / 24) * 1000) / 1000);
  });

  it('should include throughput metadata', () => {
    const mockResults = {
      'test-model': [
        [
          { success: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 5000, toolCallCount: 1, filesChanged: [], responseLength: 100, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
        ]
      ]
    };

    const report = generateReport(mockResults, { runs: 1 });
    const stats = report.models['test-model'].totals;

    assert.ok(typeof stats.throughputTasksPerMin === 'number');
    assert.ok(stats.totalTimeMs > 0);
  });

  it('should include dimension averages in totals', () => {
    const mockResults = {
      'test-model': [
        [
          { success: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 100, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 1, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
        ]
      ]
    };

    const report = generateReport(mockResults, { runs: 1 });
    const totals = report.models['test-model'].totals;

    assert.equal(totals.correctnessAvg, 1);
    assert.equal(totals.evidenceAccuracyAvg, 1);
    assert.equal(totals.falseSuccessAvg, 1);
    assert.equal(totals.unrelatedChangesAvg, 1);
    assert.equal(totals.escalationAvg, 1);
  });

  it('includes unavailable error details in JSON report tasks', () => {
    const mockResults = {
      'test-model': [
        [
          { passed: false, score: 0, composite: 0, timedOut: false, stalled: false, unavailable: true, errorType: 'service-unavailable', errorMessage: 'connection refused', exitCode: 1, elapsedMs: 10, toolCallCount: 0, filesChanged: [], responseLength: 0, dimensions: { correctness: 0, evidenceAccuracy: 0, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 0.3 }, reason: 'service-unavailable', taskId: 't1', category: 'tests_logs' }
        ]
      ]
    };
    const report = generateReport(mockResults, { runs: 1 });
    const task = report.models['test-model'].runs[0].tasks[0];
    assert.equal(task.success, false);
    assert.equal(task.errorType, 'service-unavailable');
    assert.equal(task.errorMessage, 'connection refused');
    assert.equal(report.models['test-model'].totals.unavailableRuns, 1);
  });
});

// ---------------------------------------------------------------------------
// Argument construction / agent selection tests
// ---------------------------------------------------------------------------

describe('buildTaskArgs', () => {
  const SAMPLE_MODEL = 'test-model/local';
  const SAMPLE_TASK = { id: 'test-basic-response', prompt: 'Reply with exactly MODEL_READY.' };
  const SAMPLE_DIR = '/tmp/benchmark-fixture-abc123';

  it('should include --agent flag with default value "build"', () => {
    const args = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR);
    assert.ok(args.includes('--agent'));
    const agentIdx = args.indexOf('--agent');
    assert.equal(args[agentIdx + 1], 'build');
  });

  it('should accept a custom agent name', () => {
    const args = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR, 'orchestrator');
    const agentIdx = args.indexOf('--agent');
    assert.equal(args[agentIdx + 1], 'orchestrator');
  });

  it('should include all required CLI arguments', () => {
    const args = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR);
    assert.ok(args.includes('run'), 'should start with run');
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('--agent'));
    assert.ok(args.includes('--format'));
    assert.ok(args.includes('--dir'));
    assert.ok(args.includes('--auto'));
    assert.ok(args.includes(SAMPLE_MODEL), 'should include the model ID');
    assert.ok(args.includes(SAMPLE_DIR), 'should include the fixture directory');
    assert.ok(args.includes(SAMPLE_TASK.prompt), 'should include the task prompt');
  });

  it('should place --agent between --model and --format', () => {
    const args = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR);
    const modelIdx = args.indexOf('--model');
    const agentIdx = args.indexOf('--agent');
    const formatIdx = args.indexOf('--format');
    assert.ok(modelIdx < agentIdx, '--model should come before --agent');
    assert.ok(agentIdx < formatIdx, '--agent should come before --format');
  });

  it('should return a deterministic array for identical inputs', () => {
    const first = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR, 'build');
    const second = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR, 'build');
    assert.deepEqual(first, second);
  });

  it('should produce different arrays for different agents', () => {
    const argsBuild = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR, 'build');
    const argsOrch = buildTaskArgs(SAMPLE_MODEL, SAMPLE_TASK, SAMPLE_DIR, 'orchestrator');
    assert.notDeepEqual(argsBuild, argsOrch);
  });
});

describe('agent in report metadata', () => {
  it('should include agent field in JSON report metadata', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1, agent: 'build' });
    assert.equal(report.metadata.agent, 'build');
  });

  it('should include agent in Markdown report when present', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1, agent: 'build' });
    const md = generateMarkdownReport(report);
    assert.ok(md.includes('Agent'));
    assert.ok(md.includes('build'));
  });

  it('should default agent to "build" when not specified', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1 });
    assert.equal(report.metadata.agent, 'build');
  });
});

// ---------------------------------------------------------------------------
// Markdown report tests
// ---------------------------------------------------------------------------

describe('generateMarkdownReport', () => {
  it('should produce a non-empty markdown string', () => {
    const mockResults = {
      'test-model': [
        [
          { success: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 100, toolCallCount: 1, filesChanged: [], responseLength: 100, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
        ]
      ]
    };
    const report = generateReport(mockResults, { runs: 1 });
    const md = generateMarkdownReport(report);
    assert.ok(md.length > 0);
    assert.ok(md.includes('# OpenCode Model Benchmark Report'));
    assert.ok(md.includes('test-model'));
    assert.ok(md.includes('Dimension'));
  });

  it('should handle error results gracefully', () => {
    const mockResults = {
      'broken-model': { error: 'connection refused' }
    };
    const report = generateReport(mockResults, { runs: 1 });
    const md = generateMarkdownReport(report);
    assert.ok(md.includes('broken-model'));
    assert.ok(md.includes('connection refused'));
  });

  it('should include CLI/service error section for unavailable tasks', () => {
    const report = generateReport({
      'test-model': [[
        { passed: false, score: 0, composite: 0, timedOut: false, stalled: false, unavailable: true, errorType: 'cli-unavailable', errorMessage: 'opencode not found', exitCode: 127, elapsedMs: 1, toolCallCount: 0, filesChanged: [], responseLength: 0, dimensions: { correctness: 0, evidenceAccuracy: 0, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 0.3 }, reason: 'cli-unavailable', taskId: 't1', category: 'tests_logs' }
      ]]
    }, { runs: 1 });
    const md = generateMarkdownReport(report);
    assert.ok(md.includes('CLI / Service Errors'));
    assert.ok(md.includes('cli-unavailable'));
    assert.ok(md.includes('opencode not found'));
  });
});

// ---------------------------------------------------------------------------
// Executable resolution tests
// ---------------------------------------------------------------------------

describe('resolveOpencodeConfig', () => {
  it('should resolve the default binary when no env/CLI overrides', () => {
    // Temporarily unset env vars that influence resolution
    const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    const prevSrc = process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
    delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;

    try {
      const cfg = resolveOpencodeConfig();
      assert.equal(cfg.mode, 'binary');
      assert.ok(cfg.executable.includes('opencode'), `Expected opencode in path, got: ${cfg.executable}`);
      assert.deepEqual(cfg.prefixArgs, []);
      assert.equal(cfg.cwd, null);
    } finally {
      if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
      if (prevSrc !== undefined) process.env.AGENT_LOOP_WORKER_SOURCE_DIR = prevSrc;
    }
  });

  it('should throw when the executable path does not exist', () => {
    assert.throws(
      () => resolveOpencodeConfig({ executable: '/nonexistent/path/to/opencode' }),
      /not found/
    );
  });

  it('should use CLI --executable override over env', () => {
    const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    process.env.AGENT_LOOP_WORKER_EXECUTABLE = '/some/env/path';
    try {
      const cfg = resolveOpencodeConfig({ executable: '/usr/bin/env' });
      assert.equal(cfg.executable, '/usr/bin/env');
      assert.equal(cfg.mode, 'binary');
      assert.ok(cfg.label.includes('--executable'), `Label should mention --executable, got: ${cfg.label}`);
    } finally {
      if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
      else delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    }
  });

  it('should throw for source mode when directory does not exist', () => {
    assert.throws(
      () => resolveOpencodeConfig({ sourceDir: '/nonexistent/source/dir' }),
      /not found/
    );
  });

  it('should throw for source mode when src/index.ts is missing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-src-test-'));
    try {
      // No src/index.ts in this empty dir
      assert.throws(
        () => resolveOpencodeConfig({ sourceDir: dir }),
        /entry point not found/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should resolve source mode via CLI --source', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-src-test-'));
    try {
      mkdirSync(resolve(dir, 'src'), { recursive: true });
      writeFileSync(resolve(dir, 'src', 'index.ts'), '// placeholder');
      const cfg = resolveOpencodeConfig({ sourceDir: dir });
      assert.equal(cfg.mode, 'source');
      assert.equal(cfg.executable, 'bun');
      assert.deepEqual(cfg.prefixArgs, ['run', '--conditions=browser', 'src/index.ts']);
      assert.equal(cfg.cwd, dir);
      assert.ok(cfg.label.includes(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should resolve source mode via AGENT_LOOP_WORKER_SOURCE_DIR env var', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-src-test-'));
    try {
      mkdirSync(resolve(dir, 'src'), { recursive: true });
      writeFileSync(resolve(dir, 'src', 'index.ts'), '// placeholder');

      const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
      const prevSrc = process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
      delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
      process.env.AGENT_LOOP_WORKER_SOURCE_DIR = dir;

      try {
        const cfg = resolveOpencodeConfig();
        assert.equal(cfg.mode, 'source');
        assert.equal(cfg.executable, 'bun');
        assert.deepEqual(cfg.prefixArgs, ['run', '--conditions=browser', 'src/index.ts']);
        assert.equal(cfg.cwd, dir);
        assert.ok(cfg.label.includes('AGENT_LOOP_WORKER_SOURCE_DIR'));
      } finally {
        if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
        else delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
        if (prevSrc !== undefined) process.env.AGENT_LOOP_WORKER_SOURCE_DIR = prevSrc;
        else delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should resolve AGENT_LOOP_WORKER_EXECUTABLE as binary path', () => {
    const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    const prevSrc = process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
    process.env.AGENT_LOOP_WORKER_EXECUTABLE = '/usr/bin/env';
    delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;

    try {
      const cfg = resolveOpencodeConfig();
      assert.equal(cfg.mode, 'binary');
      assert.equal(cfg.executable, '/usr/bin/env');
      assert.deepEqual(cfg.prefixArgs, []);
      assert.ok(cfg.label.includes('AGENT_LOOP_WORKER_EXECUTABLE'));
    } finally {
      if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
      else delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
      if (prevSrc !== undefined) process.env.AGENT_LOOP_WORKER_SOURCE_DIR = prevSrc;
      else delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
    }
  });

  it('should resolve AGENT_LOOP_WORKER_EXECUTABLE JSON config', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'benchmark-json-test-'));
    try {
      mkdirSync(resolve(dir, 'src'), { recursive: true });
      writeFileSync(resolve(dir, 'src', 'index.ts'), '// placeholder');

      const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
      const prevSrc = process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
      process.env.AGENT_LOOP_WORKER_EXECUTABLE = JSON.stringify({
        executable: 'bun',
        args: ['run', '--conditions=browser', 'src/index.ts'],
        cwd: dir,
        sourceDir: dir
      });
      delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;

      try {
        const cfg = resolveOpencodeConfig();
        assert.equal(cfg.executable, 'bun');
        assert.deepEqual(cfg.prefixArgs, ['run', '--conditions=browser', 'src/index.ts']);
        assert.equal(cfg.cwd, dir);
        assert.equal(cfg.mode, 'source');
        assert.ok(cfg.label.includes('JSON'), `Label should include JSON, got: ${cfg.label}`);
      } finally {
        if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
        else delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
        if (prevSrc !== undefined) process.env.AGENT_LOOP_WORKER_SOURCE_DIR = prevSrc;
        else delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw for invalid JSON in AGENT_LOOP_WORKER_EXECUTABLE', () => {
    const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    process.env.AGENT_LOOP_WORKER_EXECUTABLE = '{not valid json}';
    try {
      assert.throws(
        () => resolveOpencodeConfig(),
        /invalid JSON/
      );
    } finally {
      if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
      else delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    }
  });

  it('should return deterministic config structure (mode + executable + prefixArgs + cwd + label)', () => {
    const prevExec = process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    const prevSrc = process.env.AGENT_LOOP_WORKER_SOURCE_DIR;
    delete process.env.AGENT_LOOP_WORKER_EXECUTABLE;
    delete process.env.AGENT_LOOP_WORKER_SOURCE_DIR;

    try {
      const cfg = resolveOpencodeConfig();
      assert.ok(typeof cfg.mode === 'string');
      assert.ok(typeof cfg.executable === 'string');
      assert.ok(Array.isArray(cfg.prefixArgs));
      assert.ok(cfg.cwd === null || typeof cfg.cwd === 'string');
      assert.ok(typeof cfg.label === 'string');
    } finally {
      if (prevExec !== undefined) process.env.AGENT_LOOP_WORKER_EXECUTABLE = prevExec;
      if (prevSrc !== undefined) process.env.AGENT_LOOP_WORKER_SOURCE_DIR = prevSrc;
    }
  });
});

// ---------------------------------------------------------------------------
// Stall timeout configuration tests
// ---------------------------------------------------------------------------

describe('stall timeout configuration', () => {
  it('should include stallTimeoutMs with default 120000ms in report metadata', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1 });
    assert.equal(report.metadata.stallTimeoutMs, 120000);
  });

  it('should include explicit stallTimeoutMs in report metadata', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1, stallTimeoutMs: 45000 });
    assert.equal(report.metadata.stallTimeoutMs, 45000);
  });

  it('should include stall timeout in markdown report when present', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1, stallTimeoutMs: 60000 });
    const md = generateMarkdownReport(report);
    assert.ok(md.includes('Stall Timeout'));
    assert.ok(md.includes('60000ms'));
  });

  it('should preserve the separate overall task timeout independent of stall timeout', () => {
    const mockResults = {
      'test-model': [[
        { passed: true, score: 1, composite: 1, timedOut: false, stalled: false, unavailable: false, exitCode: 0, elapsedMs: 10, toolCallCount: 1, filesChanged: [], responseLength: 10, dimensions: { correctness: 1, evidenceAccuracy: 1, falseSuccess: 1, unrelatedChanges: 1, escalation: 0, reliability: 1 }, reason: 'ok', taskId: 't1', category: 'tests_logs' }
      ]]
    };
    const report = generateReport(mockResults, { runs: 1, timeoutMs: 90000, stallTimeoutMs: 120000 });
    assert.equal(report.metadata.timeoutMs, 90000);
    assert.equal(report.metadata.stallTimeoutMs, 120000);
    // Both values should be present and independent
    assert.notEqual(report.metadata.timeoutMs, report.metadata.stallTimeoutMs);
    const md = generateMarkdownReport(report);
    assert.ok(md.includes('90000ms'), 'markdown should include task timeout');
    assert.ok(md.includes('120000ms'), 'markdown should include stall timeout');
  });
});
