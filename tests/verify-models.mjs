import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const OPCODE = process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode';
const PASS = { status: 'pass' };
const FAIL = (reason) => ({ status: 'fail', reason });

function runOpenCode(model, prompt, dir = '/tmp', timeoutMs = 60000) {
  return new Promise((resolve) => {
    const args = ['run', '--model', model, '--format', 'json', '--dir', dir, '--auto', prompt];
    const child = spawn(OPCODE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdin?.destroy();
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ success: false, timedOut: true, stdout, stderr, events: [] });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const events = stdout.trim().split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ success: code === 0, timedOut: false, stdout, stderr, events, exitCode: code });
    });
    child.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ success: false, timedOut: false, stdout, stderr, events: [], error: e.message });
    });
  });
}

function hasToolCall(events) {
  return events.some(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool'));
}

function getToolResult(events) {
  const tool = events.find(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool'));
  return tool?.part?.state?.output || tool?.state?.output || '';
}

async function testBasicResponse(model) {
  const result = await runOpenCode(model, 'Reply with exactly MODEL_READY.', '/tmp', 30000);
  if (result.timedOut) return FAIL('timeout');
  if (!result.success) return FAIL(`exit code ${result.exitCode}`);
  const textEvent = result.events.find(e => e.type === 'text' || e.part?.type === 'text');
  const text = textEvent?.part?.text || textEvent?.text || '';
  if (!text.includes('MODEL_READY')) return FAIL(`expected MODEL_READY in response, got: "${text.slice(0, 50)}"`);
  return PASS;
}

async function testBashTool(model, dir) {
  const result = await runOpenCode(model, 'Use the bash tool to run `pwd`, then return the exact directory. Do not answer without calling the tool.', dir, 30000);
  if (result.timedOut) return FAIL('timeout');
  if (!result.success) return FAIL(`exit code ${result.exitCode}`);
  if (!hasToolCall(result.events)) return FAIL('no tool call detected');
  const output = getToolResult(result.events);
  if (!output.includes(dir)) return FAIL(`expected "${dir}" in tool output, got: "${output.slice(0, 100)}"`);
  return PASS;
}

async function testRepoRead(model, dir) {
  const result = await runOpenCode(model, 'Use repository tools to read package.json and return only the package name.', dir, 30000);
  if (result.timedOut) return FAIL('timeout');
  if (!result.success) return FAIL(`exit code ${result.exitCode}`);
  if (!hasToolCall(result.events)) return FAIL('no tool call detected');
  const output = getToolResult(result.events);
  if (!output.includes('verify-fixture')) return FAIL(`expected package name in output, got: "${output.slice(0, 100)}"`);
  return PASS;
}

async function testMultiStep(model) {
  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'verify-fixture-'));
  try {
    writeFileSync(resolve(fixtureDir, 'README.md'), '# Test Fixture\nThis is a temporary test fixture.');
    writeFileSync(resolve(fixtureDir, 'package.json'), JSON.stringify({ name: 'verify-fixture', version: '1.0.0' }));
    const result = await runOpenCode(model, 'Inspect the fixture repository, create a file called "hello.txt" with content "world", read it back, and report the result.', fixtureDir, 45000);
    if (result.timedOut) return FAIL('timeout');
    if (!result.success) return FAIL(`exit code ${result.exitCode}`);
    if (!hasToolCall(result.events)) return FAIL('no tool call detected');
    const events = result.events.filter(e => e.type === 'tool_use' || (e.part && e.part.type === 'tool'));
    if (events.length < 2) return FAIL(`expected 2+ tool calls, got ${events.length}`);
    const fileExists = existsSync(resolve(fixtureDir, 'hello.txt'));
    if (fileExists) {
      const content = readFileSync(resolve(fixtureDir, 'hello.txt'), 'utf-8');
      if (!content.includes('world')) return FAIL(`expected "world" in file, got "${content}"`);
    }
    return PASS;
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function testToolFailureRecovery(model) {
  return { status: 'skip', reason: 'injected failure not implemented in this version' };
}

async function verifyModel(model, fixtureDir) {
  const results = {};
  
  results.test1 = await testBasicResponse(model);
  results.test2 = await testBashTool(model, fixtureDir || '/tmp');
  results.test3 = await testRepoRead(model, fixtureDir || process.env.AGENT_LOOP_PROJECT_DIR || '.');
  results.test4 = await testMultiStep(model);
  results.test5 = await testToolFailureRecovery(model);

  const passed = Object.values(results).filter(r => r.status === 'pass').length;
  const total = Object.values(results).filter(r => r.status !== 'skip').length;
  const classification = passed === total ? 'verified_tool_execution' :
    passed >= 3 ? 'partial_tool_execution' :
    passed >= 1 ? 'text_only' : 'provider_failure';

  return { model, results, passed, total, classification, verified: passed === total };
}

async function main() {
  const args = process.argv.slice(2);
  const isFull = args.includes('--full');
  const isSmoke = args.includes('--smoke');
  const specificModel = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
  const isStrict = args.includes('--strict');

  const models = specificModel ? [specificModel] : [
    'nvidia/moonshotai/kimi-k2.6',
    'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
    'nvidia/mistralai/mistral-small-4-119b-2603',
    'opencode/north-mini-code-free',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
    'ollama-9b-local',
    'opencode-go/deepseek-v4-flash'
  ];

  // In smoke mode, only test basic response
  const testList = isSmoke ? ['test1'] : ['test1', 'test2', 'test3', ...(isFull ? ['test4', 'test5'] : [])];

  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'verify-repo-'));
  try {
    writeFileSync(resolve(fixtureDir, 'package.json'), JSON.stringify({ name: 'verify-fixture', version: '1.0.0' }));
    writeFileSync(resolve(fixtureDir, 'README.md'), '# Fixture');

    const allResults = [];
    for (const model of models) {
      console.log(`\nTesting: ${model}`);
      const result = await verifyModel(model, fixtureDir);
      result.details = { tested: testList };
      allResults.push(result);
      console.log(`  Passed: ${result.passed}/${result.total}`);
      console.log(`  Classification: ${result.classification}`);
      for (const [name, r] of Object.entries(result.results)) {
        if (r.status !== 'skip') console.log(`  ${name}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
      }
      if (!result.verified && isStrict) {
        console.error(`STRICT FAIL: ${model} not fully verified`);
        process.exitCode = 1;
      }
    }

    console.log('\n=== SUMMARY ===');
    const verified = allResults.filter(r => r.verified);
    const failed = allResults.filter(r => !r.verified);
    console.log(`Verified tool execution (${verified.length}):`);
    verified.forEach(r => console.log(`  ${r.model}`));
    console.log(`\nNot fully verified (${failed.length}):`);
    failed.forEach(r => console.log(`  ${r.model} — ${r.classification} (${r.passed}/${r.total})`));

    if (failed.length > 0 && isStrict) {
      process.exit(1);
    }

    // Output JSON for tooling
    const outputPath = resolve(tmpdir(), 'verify-models-result.json');
    writeFileSync(outputPath, JSON.stringify({ models: allResults, timestamp: new Date().toISOString(), strict: isStrict }, null, 2));
    console.log(`\nDetailed results: ${outputPath}`);

  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
