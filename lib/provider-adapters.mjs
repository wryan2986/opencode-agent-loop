const LOCAL_MODEL_PATTERNS = [/^ollama(?:-|\/)/i, /^local(?:-|\/)/i, /-local$/i];

function normalizedRetryPolicy(base = {}, override = {}) {
  return {
    maxRetries: Number.isInteger(override.max_retries) ? override.max_retries : Number.isInteger(base.max_retries) ? base.max_retries : null,
    retryableHttpCodes: override.retryable_http_codes || base.retryable_http_codes || [],
    retryableErrors: override.retryable_errors || base.retryable_errors || [],
    nonRetryableErrors: override.non_retryable_errors || base.non_retryable_errors || []
  };
}

export class ProviderAdapter {
  constructor({ id, aliases = [], local = false, timeoutKey = id, retry = {} } = {}) {
    if (!id) throw new Error('ProviderAdapter requires id');
    this.id = id;
    this.aliases = aliases.map(alias => String(alias).toLowerCase());
    this.local = local;
    this.timeoutKey = timeoutKey;
    this.retry = retry;
  }

  matches(modelId, explicitProvider) {
    const provider = String(explicitProvider || '').toLowerCase();
    if (provider === this.id || this.aliases.includes(provider)) return true;
    return this.modelProvider(modelId) === this.id;
  }

  modelProvider(modelId) {
    const value = String(modelId || '');
    if (!value) return 'unknown';
    if (LOCAL_MODEL_PATTERNS.some(pattern => pattern.test(value))) return 'local';
    const slash = value.indexOf('/');
    return slash > 0 ? value.slice(0, slash).toLowerCase() : 'unknown';
  }

  retryPolicy(globalPolicy = {}, providerPolicy = {}) {
    return normalizedRetryPolicy(globalPolicy, { ...this.retry, ...providerPolicy });
  }

  shouldRetry(error, globalPolicy = {}, providerPolicy = {}) {
    const policy = this.retryPolicy(globalPolicy, providerPolicy);
    const code = error?.code || error?.error?.code || '';
    const status = Number(error?.statusCode || error?.status || error?.error?.statusCode || 0);
    if (policy.nonRetryableErrors.includes(code)) return false;
    if (policy.retryableErrors.includes(code)) return true;
    if (policy.retryableHttpCodes.includes(status)) return true;
    return null;
  }

  normalizeError({ stdout = '', stderr = '', exitCode = 0 } = {}) {
    const combined = `${stderr}\n${stdout}`;
    const statusMatch = combined.match(/\b(400|401|402|403|404|408|409|410|422|429|500|502|503|504)\b/);
    const codeMatch = combined.match(/\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UNAUTHORIZED|FORBIDDEN|BILLING_DISABLED|SAFETY_REJECTION)\b/);
    const sessionMatch = combined.match(/session(?:ID|Id| id)?[\s:=]+([a-zA-Z0-9_-]+)/);
    return {
      statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
      code: codeMatch ? codeMatch[1] : undefined,
      provider: this.id,
      sessionId: sessionMatch ? sessionMatch[1] : undefined,
      message: combined.slice(0, 2000),
      exitCode
    };
  }
}

export class LocalProviderAdapter extends ProviderAdapter {
  constructor() {
    super({
      id: 'local',
      aliases: ['ollama', 'rx580-llama'],
      local: true,
      timeoutKey: 'local',
      retry: {
        max_retries: 1,
        retryable_errors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']
      }
    });
  }
}

const adapters = new Map();

export function registerProviderAdapter(adapter) {
  if (!(adapter instanceof ProviderAdapter)) throw new TypeError('registerProviderAdapter expects ProviderAdapter');
  adapters.set(adapter.id, adapter);
  for (const alias of adapter.aliases) adapters.set(alias, adapter);
  return adapter;
}

export function listProviderAdapters() {
  return [...new Set(adapters.values())];
}

export function resolveProviderAdapter(modelId, explicitProvider) {
  const explicit = String(explicitProvider || '').toLowerCase();
  if (explicit && adapters.has(explicit)) return adapters.get(explicit);
  for (const adapter of listProviderAdapters()) {
    if (adapter.matches(modelId, explicitProvider)) return adapter;
  }
  const prefix = String(modelId || '').split('/')[0].toLowerCase();
  return adapters.get(prefix) || new ProviderAdapter({ id: prefix && prefix !== modelId ? prefix : 'unknown' });
}

export function deriveProviderFromModel(modelId, explicitProvider) {
  return resolveProviderAdapter(modelId, explicitProvider).id;
}

export function providerTimeoutKey(modelId, explicitProvider) {
  return resolveProviderAdapter(modelId, explicitProvider).timeoutKey;
}

for (const id of ['opencode', 'opencode-go', 'nvidia', 'cerebras', 'groq', 'openrouter', 'openai']) {
  registerProviderAdapter(new ProviderAdapter({ id }));
}
registerProviderAdapter(new LocalProviderAdapter());
