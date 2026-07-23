import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(testDir, '..', 'bin', 'bounty-http.mjs');

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function localManifest(origin) {
  return {
    mode: 'local_lab',
    authorization: { confirmed: true },
    scope: {
      allowed_origins: [origin],
      allowed_path_prefixes: ['/api'],
      excluded_origins: [],
      excluded_path_prefixes: ['/api/private'],
      allowed_methods: ['GET'],
      max_requests_per_minute: 2,
      max_total_requests_per_case: 2,
      max_response_bytes: 4096,
      follow_redirects: false,
      allow_private_networks: true,
      identification_headers: { Authorization: 'Bearer test-secret' },
    },
    safety: { allow_state_change: false },
    reporting: { auto_submit: false },
  };
}

test('wrapper permits scoped local-lab request, saves body, and redacts secret header', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, path: request.url }));
  }, async origin => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-http-'));
    const manifestPath = path.join(workspace, '.bounty-loop', 'program.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(localManifest(origin)));
    const output = path.join(workspace, '.bounty-loop', 'cases', 'case-1', 'evidence', 'response.json');

    const result = await run([
      '--manifest', '.bounty-loop/program.json',
      '--method', 'GET',
      '--url', `${origin}/api/items`,
      '--output', '.bounty-loop/cases/case-1/evidence/response.json',
    ], workspace);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.match(summary.request.headers.authorization, /REDACTED/);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), { ok: true, path: '/api/items' });
  });
});

test('wrapper blocks excluded paths before request', async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.end('unexpected');
  }, async origin => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-http-'));
    const manifestPath = path.join(workspace, '.bounty-loop', 'program.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(localManifest(origin)));

    const result = await run([
      '--manifest', '.bounty-loop/program.json',
      '--url', `${origin}/api/private/users`,
    ], workspace);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /excluded/);
    assert.equal(requests, 0);
  });
});

test('wrapper enforces per-case total request budget', async () => {
  await withServer((_request, response) => response.end('ok'), async origin => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bounty-http-'));
    const manifest = localManifest(origin);
    manifest.scope.max_requests_per_minute = 10;
    manifest.scope.max_total_requests_per_case = 1;
    const manifestPath = path.join(workspace, '.bounty-loop', 'program.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const first = await run(['--manifest', '.bounty-loop/program.json', '--url', `${origin}/api/one`], workspace);
    const second = await run(['--manifest', '.bounty-loop/program.json', '--url', `${origin}/api/two`], workspace);
    assert.equal(first.code, 0, first.stderr);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /budget exhausted/);
  });
});
