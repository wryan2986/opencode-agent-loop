import { ProviderAdapter, registerProviderAdapter } from '../lib/provider-adapters.mjs';

class ExampleProviderAdapter extends ProviderAdapter {
  constructor() {
    super({ id: 'example', aliases: ['example-cloud'], timeoutKey: 'example' });
  }

  normalizeError(result) {
    const normalized = super.normalizeError(result);
    if (/daily allowance/i.test(normalized.message)) {
      normalized.statusCode = 429;
      normalized.code = 'DAILY_QUOTA_EXHAUSTED';
    }
    return normalized;
  }
}

registerProviderAdapter(new ExampleProviderAdapter());
