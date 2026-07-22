# Provider adapters

Provider-specific behavior is isolated behind `ProviderAdapter` implementations in `lib/provider-adapters.mjs`.

An adapter provides:

- provider identity and aliases
- local/unmetered classification
- timeout configuration key
- provider-error normalization
- model-ID matching

Built-in adapters cover OpenCode, OpenCode Go, NVIDIA, Cerebras, Groq, OpenRouter, OpenAI, and local/Ollama model IDs.

## Custom adapter

Create a subclass and register it before running workers:

```js
import { ProviderAdapter, registerProviderAdapter } from './lib/provider-adapters.mjs';

class AcmeAdapter extends ProviderAdapter {
  constructor() {
    super({ id: 'acme', aliases: ['acme-ai'], timeoutKey: 'acme' });
  }

  normalizeError(result) {
    const normalized = super.normalizeError(result);
    // Add provider-specific status and quota mappings here.
    return normalized;
  }
}

registerProviderAdapter(new AcmeAdapter());
```

See `examples/provider-adapter.mjs` for a complete example.

Add the provider's timeout to `provider_timeouts_ms` and `smoke_test_provider_timeout_ms`. Model entries remain in `config/model-registry.json`; role order remains in `config/free-first-pools.json`.

## Provider-specific retry policy

Use the optional `provider_retry` map in `config/free-first-config.json` to cap retries or override retryable and non-retryable codes for one provider. The adapter combines that policy with the global retry defaults. A provider-specific cap can reduce, but cannot increase, the caller's `maxRetries` value.
