#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import net from 'node:net';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_BLOCKED_METHODS = new Set(['CONNECT', 'TRACE']);
const SECRET_HEADER_PATTERN = /authorization|cookie|token|api[-_]?key|secret|password|session/i;
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

function fail(message, code = 1) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const parsed = { headers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`, 2);
    const key = arg.slice(2);
    if (key === 'header') {
      const value = argv[++index];
      if (!value) fail('--header requires a value', 2);
      parsed.headers.push(value);
      continue;
    }
    const value = argv[++index];
    if (!value) fail(`--${key} requires a value`, 2);
    parsed[key.replaceAll('-', '_')] = value;
  }
  return parsed;
}

function normalizeOrigin(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported scheme: ${url.protocol}`);
  if (url.username || url.password) throw new Error('Credentials in URL are prohibited');
  return url.origin;
}

function pathMatches(pathname, prefixes) {
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

function evaluateScope(manifest, rawUrl, method) {
  const reasons = [];
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reasons: ['Invalid URL'] };
  }
  if (!['http:', 'https:'].includes(url.protocol)) reasons.push(`Scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) reasons.push('Credentials in URL are prohibited');
  const allowedOrigins = (manifest.scope?.allowed_origins || []).map(normalizeOrigin);
  const excludedOrigins = (manifest.scope?.excluded_origins || []).map(normalizeOrigin);
  const allowedPrefixes = manifest.scope?.allowed_path_prefixes || ['/'];
  const excludedPrefixes = manifest.scope?.excluded_path_prefixes || [];
  if (!allowedOrigins.includes(url.origin)) reasons.push(`Origin ${url.origin} is not allowed`);
  if (excludedOrigins.includes(url.origin)) reasons.push(`Origin ${url.origin} is excluded`);
  if (!pathMatches(url.pathname, allowedPrefixes)) reasons.push(`Path ${url.pathname} is not allowed`);
  if (pathMatches(url.pathname, excludedPrefixes)) reasons.push(`Path ${url.pathname} is excluded`);
  const allowedMethods = (manifest.scope?.allowed_methods || []).map(value => String(value).toUpperCase());
  if (!allowedMethods.includes(method)) reasons.push(`Method ${method} is not allowed`);
  if (ALWAYS_BLOCKED_METHODS.has(method)) reasons.push(`Method ${method} is always prohibited`);
  if (manifest.safety?.allow_state_change !== true && !SAFE_METHODS.has(method)) {
    reasons.push(`Method ${method} is state-changing while allow_state_change is false`);
  }
  return { allowed: reasons.length === 0, reasons, url };
}

function isPrivateOrReservedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
  }
  return true;
}

async function assertPublicResolution(url, allowPrivateNetworks) {
  if (allowPrivateNetworks) return;
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`Hostname ${url.hostname} did not resolve`);
  const blocked = records.filter(record => isPrivateOrReservedAddress(record.address));
  if (blocked.length > 0) {
    throw new Error(`Hostname resolves to a private or reserved address: ${blocked.map(item => item.address).join(', ')}`);
  }
}

function parseHeaders(values, manifestHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(manifestHeaders || {})) {
    if (!name || FORBIDDEN_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, String(value));
  }
  for (const item of values) {
    const separator = item.indexOf(':');
    if (separator <= 0) throw new Error(`Invalid header format: ${item}`);
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new Error(`Header ${name} is prohibited`);
    headers.set(name, value);
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'OpenCode-Bug-Bounty-Validation-Loop/0.1');
  return headers;
}

function redactHeaders(headers) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    output[name] = SECRET_HEADER_PATTERN.test(name)
      ? `[REDACTED sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}]`
      : value;
  }
  return output;
}

function assertInside(root, candidate, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} must be inside ${absoluteRoot}`);
  return absoluteCandidate;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

async function consumeRateBudget(workspace, manifest) {
  const ledgerPath = path.join(workspace, '.bounty-loop', 'http-ledger.json');
  let ledger = { total: 0, timestamps: [] };
  try {
    ledger = await readJson(ledgerPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const now = Date.now();
  ledger.timestamps = (ledger.timestamps || []).filter(timestamp => now - timestamp < 60_000);
  const perMinute = manifest.scope.max_requests_per_minute;
  const maxTotal = manifest.scope.max_total_requests_per_case;
  if (ledger.timestamps.length >= perMinute) {
    const waitMs = 60_000 - (now - ledger.timestamps[0]);
    throw new Error(`Rate limit reached; retry after at least ${Math.ceil(waitMs / 1000)} seconds`);
  }
  if ((ledger.total || 0) >= maxTotal) throw new Error(`Case request budget exhausted at ${maxTotal} requests`);
  ledger.timestamps.push(now);
  ledger.total = (ledger.total || 0) + 1;
  await writeJsonAtomic(ledgerPath, ledger);
  return { total: ledger.total, recent: ledger.timestamps.length };
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`Response exceeded max_response_bytes (${maxBytes})`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function fetchScoped({ manifest, url, method, headers, body, maxRedirects = 3 }) {
  let current = url;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const scope = evaluateScope(manifest, current.href, method);
    if (!scope.allowed) throw new Error(`Request blocked by scope: ${scope.reasons.join('; ')}`);
    await assertPublicResolution(current, manifest.scope.allow_private_networks === true);
    const response = await fetch(current, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.href, redirects: redirectCount };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current.href, redirects: redirectCount };
    if (manifest.scope.follow_redirects !== true) {
      return { response, finalUrl: current.href, redirects: redirectCount, blockedRedirect: new URL(location, current).href };
    }
    const next = new URL(location, current);
    const nextScope = evaluateScope(manifest, next.href, method);
    if (!nextScope.allowed) throw new Error(`Redirect left scope: ${next.href}: ${nextScope.reasons.join('; ')}`);
    current = next;
  }
  throw new Error(`Redirect limit exceeded (${maxRedirects})`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.url) {
  fail('Usage: bounty-http.mjs --manifest <path> --url <url> [--method GET] [--header "Name: value"] [--body-file path] [--output path]', 2);
}

try {
  const workspace = process.cwd();
  const manifestPath = assertInside(path.join(workspace, '.bounty-loop'), args.manifest, 'Manifest path');
  const manifest = await readJson(manifestPath);
  if (manifest.authorization?.confirmed !== true) throw new Error('Manifest authorization is not confirmed');
  if (manifest.reporting?.auto_submit === true) throw new Error('Manifest is unsafe: auto_submit must be false');
  const method = String(args.method || 'GET').toUpperCase();
  const scope = evaluateScope(manifest, args.url, method);
  if (!scope.allowed) throw new Error(`Request blocked by scope: ${scope.reasons.join('; ')}`);
  const headers = parseHeaders(args.headers, manifest.scope.identification_headers);
  let body;
  if (args.body_file) {
    const bodyPath = assertInside(path.join(workspace, '.bounty-loop', 'requests'), args.body_file, 'Body file');
    body = await fs.readFile(bodyPath);
  }
  if (body && SAFE_METHODS.has(method)) throw new Error(`${method} requests may not include a body`);
  const budget = await consumeRateBudget(workspace, manifest);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = await fetchScoped({ manifest, url: scope.url, method, headers, body });
  const responseBody = await readLimitedBody(result.response, manifest.scope.max_response_bytes);
  let outputPath = null;
  if (args.output) {
    outputPath = assertInside(path.join(workspace, '.bounty-loop', 'cases'), args.output, 'Output path');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, responseBody, { mode: 0o600 });
  }
  const summary = {
    ok: true,
    request: {
      method,
      url: scope.url.href,
      headers: redactHeaders(headers),
      body_bytes: body?.length || 0,
    },
    response: {
      status: result.response.status,
      status_text: result.response.statusText,
      final_url: result.finalUrl,
      redirects: result.redirects,
      blocked_redirect: result.blockedRedirect || null,
      headers: redactHeaders(result.response.headers),
      body_bytes: responseBody.length,
      body_sha256: crypto.createHash('sha256').update(responseBody).digest('hex'),
      body_saved_to: outputPath ? path.relative(workspace, outputPath) : null,
    },
    budget,
    timing: {
      started_at: startedAt,
      duration_ms: Date.now() - started,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  fail(error.message);
}
