import crypto from 'node:crypto';

const SECRET_KEY_PATTERN = /authorization|cookie|set-cookie|token|api[-_]?key|secret|password|session/i;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        return [key, `[REDACTED sha256:${shortHash(value)}]`];
      }
      return [key, String(value)];
    }),
  );
}

export function redactValue(value, key = '') {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redactValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]');
  }
  return value;
}
