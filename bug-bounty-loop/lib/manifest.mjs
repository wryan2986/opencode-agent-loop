import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_BLOCKED_METHODS = new Set(['CONNECT', 'TRACE']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, name, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${name} must be an object`);
    return {};
  }
  return value;
}

function requireString(value, name, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    errors.push(`${name} must be a non-empty string`);
    return '';
  }
  return value.trim();
}

function requireBoolean(value, name, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${name} must be a boolean`);
    return false;
  }
  return value;
}

function requirePositiveInteger(value, name, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer from ${min} to ${max}`);
    return min;
  }
  return value;
}

export function normalizeOrigin(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Origins must not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Origin must not include a path, query, or fragment: ${raw}`);
  }
  return url.origin;
}

function normalizePathPrefix(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) {
    throw new Error(`Path prefix must begin with '/': ${String(raw)}`);
  }
  return raw;
}

function normalizeMethod(raw) {
  const method = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error(`Invalid HTTP method: ${String(raw)}`);
  }
  if (ALWAYS_BLOCKED_METHODS.has(method)) {
    throw new Error(`${method} is always prohibited by this loop`);
  }
  return method;
}

function normalizeStringArray(value, name, errors, mapper = value => value) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${name} must be a non-empty array`);
    return [];
  }
  const output = [];
  for (const item of value) {
    try {
      output.push(mapper(item));
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return [...new Set(output)];
}

function validateSnapshotDate(value, errors) {
  const text = requireString(value, 'program.policy_snapshot_date', errors);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    errors.push('program.policy_snapshot_date must use YYYY-MM-DD');
    return text;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    errors.push('program.policy_snapshot_date is not a valid date');
  }
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (parsed > tomorrow) {
    errors.push('program.policy_snapshot_date cannot be in the future');
  }
  return text;
}

export function validateManifest(input, { requireAuthorization = true } = {}) {
  const errors = [];
  const root = requireObject(input, 'manifest', errors);
  const program = requireObject(root.program, 'program', errors);
  const authorization = requireObject(root.authorization, 'authorization', errors);
  const scope = requireObject(root.scope, 'scope', errors);
  const safety = requireObject(root.safety, 'safety', errors);
  const reporting = requireObject(root.reporting, 'reporting', errors);

  const mode = root.mode === 'local_lab' ? 'local_lab' : 'authorized_program';
  const normalized = {
    schema_version: root.schema_version === 1 ? 1 : 1,
    mode,
    program: {
      name: requireString(program.name, 'program.name', errors),
      platform: requireString(program.platform, 'program.platform', errors),
      policy_url: requireString(program.policy_url, 'program.policy_url', errors),
      policy_snapshot_date: validateSnapshotDate(program.policy_snapshot_date, errors),
    },
    authorization: {
      confirmed: requireBoolean(authorization.confirmed, 'authorization.confirmed', errors),
      confirmed_by: requireString(authorization.confirmed_by, 'authorization.confirmed_by', errors),
      testing_identity: requireString(authorization.testing_identity, 'authorization.testing_identity', errors),
      notes: typeof authorization.notes === 'string' ? authorization.notes.trim() : '',
    },
    scope: {
      allowed_origins: normalizeStringArray(scope.allowed_origins, 'scope.allowed_origins', errors, normalizeOrigin),
      allowed_path_prefixes: normalizeStringArray(
        scope.allowed_path_prefixes ?? ['/'],
        'scope.allowed_path_prefixes',
        errors,
        normalizePathPrefix,
      ),
      excluded_origins: Array.isArray(scope.excluded_origins)
        ? [...new Set(scope.excluded_origins.map(value => normalizeOrigin(value)))]
        : [],
      excluded_path_prefixes: Array.isArray(scope.excluded_path_prefixes)
        ? [...new Set(scope.excluded_path_prefixes.map(value => normalizePathPrefix(value)))]
        : [],
      allowed_methods: normalizeStringArray(
        scope.allowed_methods ?? ['GET', 'HEAD', 'OPTIONS'],
        'scope.allowed_methods',
        errors,
        normalizeMethod,
      ),
      max_requests_per_minute: requirePositiveInteger(
        scope.max_requests_per_minute,
        'scope.max_requests_per_minute',
        errors,
        1,
        60,
      ),
      max_total_requests_per_case: requirePositiveInteger(
        scope.max_total_requests_per_case,
        'scope.max_total_requests_per_case',
        errors,
        1,
        500,
      ),
      max_response_bytes: requirePositiveInteger(
        scope.max_response_bytes,
        'scope.max_response_bytes',
        errors,
        1024,
        5 * 1024 * 1024,
      ),
      follow_redirects: requireBoolean(scope.follow_redirects, 'scope.follow_redirects', errors),
      allow_private_networks: requireBoolean(scope.allow_private_networks, 'scope.allow_private_networks', errors),
      identification_headers: isPlainObject(scope.identification_headers)
        ? Object.fromEntries(
            Object.entries(scope.identification_headers)
              .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
              .map(([key, value]) => [key.trim(), value.trim()]),
          )
        : {},
    },
    safety: {
      only_owned_test_accounts: requireBoolean(
        safety.only_owned_test_accounts,
        'safety.only_owned_test_accounts',
        errors,
      ),
      allow_state_change: requireBoolean(safety.allow_state_change, 'safety.allow_state_change', errors),
      stop_on_real_user_data: requireBoolean(
        safety.stop_on_real_user_data,
        'safety.stop_on_real_user_data',
        errors,
      ),
      stop_on_service_instability: requireBoolean(
        safety.stop_on_service_instability,
        'safety.stop_on_service_instability',
        errors,
      ),
      prohibited_tests: Array.isArray(safety.prohibited_tests)
        ? safety.prohibited_tests.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
        : [],
    },
    reporting: {
      human_approval_required: requireBoolean(
        reporting.human_approval_required,
        'reporting.human_approval_required',
        errors,
      ),
      auto_submit: requireBoolean(reporting.auto_submit, 'reporting.auto_submit', errors),
    },
  };

  if (requireAuthorization && normalized.authorization.confirmed !== true) {
    errors.push('authorization.confirmed must be true before active testing');
  }
  if (!normalized.safety.only_owned_test_accounts) {
    errors.push('safety.only_owned_test_accounts must remain true');
  }
  if (!normalized.safety.stop_on_real_user_data) {
    errors.push('safety.stop_on_real_user_data must remain true');
  }
  if (!normalized.safety.stop_on_service_instability) {
    errors.push('safety.stop_on_service_instability must remain true');
  }
  if (!normalized.reporting.human_approval_required) {
    errors.push('reporting.human_approval_required must remain true');
  }
  if (normalized.reporting.auto_submit) {
    errors.push('reporting.auto_submit must remain false');
  }
  if (!normalized.safety.allow_state_change) {
    const unsafeMethods = normalized.scope.allowed_methods.filter(method => !SAFE_METHODS.has(method));
    if (unsafeMethods.length > 0) {
      errors.push(
        `scope.allowed_methods contains state-changing methods while safety.allow_state_change is false: ${unsafeMethods.join(', ')}`,
      );
    }
  }
  if (mode !== 'local_lab' && normalized.scope.allow_private_networks) {
    errors.push('scope.allow_private_networks may only be true in local_lab mode');
  }
  if (normalized.scope.allowed_origins.some(origin => normalized.scope.excluded_origins.includes(origin))) {
    errors.push('An origin cannot be both allowed and excluded');
  }

  return { valid: errors.length === 0, errors, manifest: normalized };
}

export async function loadManifest(filePath, options) {
  const absolute = path.resolve(filePath);
  const text = await fs.readFile(absolute, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error.message}`);
  }
  const result = validateManifest(parsed, options);
  if (!result.valid) {
    const error = new Error(`Manifest validation failed:\n- ${result.errors.join('\n- ')}`);
    error.validationErrors = result.errors;
    throw error;
  }
  return { ...result, path: absolute };
}

function pathMatches(pathname, prefixes) {
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

export function evaluateUrlScope(manifest, rawUrl, method = 'GET') {
  const reasons = [];
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reasons: ['URL is invalid'], url: null };
  }

  if (!['http:', 'https:'].includes(url.protocol)) reasons.push(`Scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) reasons.push('Credentials in URLs are not allowed');
  if (!manifest.scope.allowed_origins.includes(url.origin)) reasons.push(`Origin ${url.origin} is not in allowed_origins`);
  if (manifest.scope.excluded_origins.includes(url.origin)) reasons.push(`Origin ${url.origin} is explicitly excluded`);
  if (!pathMatches(url.pathname, manifest.scope.allowed_path_prefixes)) {
    reasons.push(`Path ${url.pathname} is outside allowed_path_prefixes`);
  }
  if (pathMatches(url.pathname, manifest.scope.excluded_path_prefixes)) {
    reasons.push(`Path ${url.pathname} is explicitly excluded`);
  }

  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (!manifest.scope.allowed_methods.includes(normalizedMethod)) {
    reasons.push(`Method ${normalizedMethod} is not allowed by the manifest`);
  }
  if (ALWAYS_BLOCKED_METHODS.has(normalizedMethod)) reasons.push(`Method ${normalizedMethod} is always prohibited`);
  if (!manifest.safety.allow_state_change && !SAFE_METHODS.has(normalizedMethod)) {
    reasons.push(`Method ${normalizedMethod} is state-changing while allow_state_change is false`);
  }

  return { allowed: reasons.length === 0, reasons, url };
}

export function isPrivateOrReservedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff')
    );
  }
  return true;
}
