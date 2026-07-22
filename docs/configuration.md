# Configuration

OpenCode Agent Loop separates stable model metadata, role ordering, and runtime policy into three JSON files.

## Files

### `config/free-first-config.json`

Controls global behavior such as:

- whether free-first routing is enabled
- whether paid fallback is allowed
- retry and cooldown durations
- smoke-test behavior
- privacy classifications
- paid-call limits
- delegated-worker token and cost budgets

The file references `config/free-first-config-schema.json` for editor validation. Treat it as policy. Do not store provider keys or other credentials in it.

### `config/free-first-pools.json`

Defines the ordered models available to each role. Every pool uses ordered failover. A typical pool contains:

1. one or more free models from different providers
2. optional local models
3. one or more paid fallbacks

Runtime health data should not be committed to this file. Fields such as `cooldown_until`, `consecutive_failures`, and `last_failure_reason` belong in an ignored runtime-state file.

### `config/model-registry.json`

Stores model capabilities and data-handling metadata, including:

- provider and model ID
- context and output limits
- tool and vision support
- coding, orchestration, review, and debugging scores
- privacy classification
- whether sensitive code is allowed
- paid equivalent or fallback information
- structured pricing where known

The registry is descriptive configuration, not a runtime log. Health-check timestamps and failure counters should be initialized to clean values in version control.

## Routing strategy

The intended default strategy is:

- paid DeepSeek V4 Flash for the parent orchestrator
- free-first pools for delegated build, test, review, and related worker calls
- paid fallback only after suitable free providers are unavailable or fail
- GPT-5.6 Luna for explicit escalation and difficult diagnosis

The `/feature` command must make delegated calls through the `agent_loop` custom tool. Direct use of OpenCode's built-in `task` tool bypasses this package's router, failover controller, and budget ledger.

## Task budgets

The `budgets` section in `config/free-first-config.json` enforces a shared limit for one stable task ID across smoke, build, test, review, escalation, and provider-failover attempts.

Default limits are:

- 250,000 total tokens
- 200,000 input tokens
- 50,000 output plus reasoning tokens
- $1.00 estimated or provider-reported cost

OpenCode `step_finish` events provide input, output, reasoning, cache-read, cache-write, and provider-reported cost data. The runtime tracks those values by task step and model. Cost estimation uses structured `pricing` fields in `config/model-registry.json`; legacy price text is supported for compatibility. Unknown paid-model prices use the conservative fallback rates in `unknown_paid_model_pricing` unless `fail_closed_on_unknown_pricing` is enabled.

The reported `scope` is `delegated-workers`. The parent orchestrator model's own conversation usage is not included in this ledger, so the budget snapshot must not be presented as the complete cost of the entire OpenCode session.

When any limit is crossed, the active worker is terminated, failover stops, and the structured result returns `code: "BUDGET_EXCEEDED"` with the complete worker-budget snapshot. The runtime continues recording any final usage events emitted while the process shuts down so the ledger does not understate the completed request.

Reuse the same optional `taskId` in every sequential `agent_loop` call belonging to one feature. Starting a new task ID after exhaustion would bypass the configured safety limit and is prohibited by the `/feature` contract.

### Ledger retention

Budget ledgers live in the long-running plugin process so separate stage calls can share totals. To prevent unbounded memory growth:

- `ledger_ttl_minutes` expires inactive ledgers; default: 1,440 minutes
- `max_tracked_tasks` caps retained ledgers; default: 1,000 tasks

Expired or oldest inactive ledgers are pruned when a new tracker is created. These values affect in-memory accounting only; they do not delete repository logs.

## Provider cooldowns

Rate-limit and transient availability failures may affect an entire provider. When a provider-wide failure is detected:

1. record the failure in runtime state
2. skip other models from that provider during the cooldown
3. select the next enabled model from a different provider
4. preserve task checkpoint context before retrying

Do not commit local cooldown state back into the repository.

## Privacy classifications

Tasks are classified before routing. Sensitive tasks must not be sent to providers whose registry entry disallows sensitive code. Local-only tasks must remain on approved local models.

Configuration cannot replace provider-contract review. Verify each provider's current data policy before using it with confidential code.

## Environment variables

See `.env.example` for supported environment variables. Keep secrets in the environment or an external secret manager. Never add API keys to JSON configuration, agent Markdown, logs, or issue reports.

## Validation

Run:

```bash
npm run validate
```

The validation command checks repository structure, agent permissions, routing defaults, the budget policy and referenced schema, `/feature` integration, documentation links, and the deterministic test suites.