# Configuration

OpenCode Agent Loop separates stable model metadata, role ordering, runtime policy, and generated state.

## Stable configuration

### `config/free-first-config.json`

Controls free-first and paid-fallback policy, retries, cooldowns, provider timeouts, privacy classifications, budgets, state retention, and structured event logging. Treat it as policy; never store credentials in it.

### `config/free-first-pools.json`

Defines ordered model candidates for every role. A pool normally contains free models from different providers, optional local models, and controlled paid fallbacks. Runtime cooldowns and failure counters do not belong in this committed file.

### `config/model-registry.json`

Stores stable model identity, capability, privacy, retirement, and pricing metadata.

### `config/free-first-config-schema.json`

Defines the supported policy structure. CI also runs semantic checks that JSON Schema alone cannot express.

## Routing strategy

The default strategy is:

- paid DeepSeek V4 Flash for the parent orchestrator
- free-first pools for delegated build, test, review, exploration, and reconciliation work
- local models for suitable low-cost or private tasks
- controlled paid fallback after suitable free/local choices fail or are unavailable
- GPT-5.6 Luna for explicit escalation and difficult diagnosis

The `/feature` command must make delegated calls through `agent_loop`. Direct use of OpenCode's built-in `task` tool bypasses this package's router and safety controls.

Provider adapters normalize identity, timeout selection, and provider-specific errors. See [Provider Adapters](provider-adapters.md).

## Retry policy

`maxRetries` controls retries of the same model after transient provider or network failures. Retries use exponential backoff plus jitter and count toward the task budget. Provider failover begins only after same-model retries are exhausted.

Authentication, billing, safety, invalid-request, task-quality, cancellation, and budget failures are terminal.

## Task budgets

One stable task ID shares a ledger across smoke, build, test, review, fixes, escalation, and provider failover.

Default limits are:

- 250,000 delegated-worker tokens
- 200,000 input tokens
- 50,000 output plus reasoning tokens
- $1.00 estimated or provider-reported delegated-worker cost
- 12 workflow calls

The greater of estimated and provider-reported cost is charged. Unknown paid-model prices use `unknown_paid_model_pricing` unless fail-closed behavior is enabled.

### Persistence

With `persist_state: true`, ledgers are atomically stored at:

```text
<project>/.opencode/agent-loop-state/budgets.json
```

They survive OpenCode and plugin restarts. `ledger_ttl_minutes` and `max_tracked_tasks` bound retained state. `AGENT_LOOP_BUDGET_STATE_PATH` can override the path for testing or managed deployments.

A snapshot reports limits, remaining allowance, token and cost usage, workflow calls by stage, per-stage and per-model totals, unknown-pricing models, and exceeded reasons.

`BUDGET_EXCEEDED` is terminal for the task ID. Starting the same work with a replacement ID is a budget bypass and is prohibited.

### Parent-orchestrator scope

The runtime limits parent orchestration with a workflow-call ceiling and a reduced maximum turn count. OpenCode does not currently expose parent-session token and cost events to this plugin, so precise parent-model tokens and dollars are not included. Results state `parentModelUsageIncluded: false` rather than claiming a complete task-cost total.

## Paid fallback audit state

Paid fallback selections and call counters are persisted per project under `.opencode/agent-loop-state/`. The audit log contains only model, role, failure-code, and outcome metadata; it excludes prompts and credentials. Persistent counters prevent a process restart from resetting per-task or global paid-call ceilings.

## Structured events

The default append-only stream is:

```text
<project>/.opencode/agent-loop-state/events.jsonl
```

Events conform to `config/agent-loop-event.schema.json` and cover stages, model attempts, retries, provider cooldowns, budget updates, and completion. See [Structured Event Logging](event-logging.md).

## Provider timeouts

Timeouts are selected through provider adapters. Local IDs such as `ollama-9b-local` resolve to the `local` timeout even without a slash. The configured local timeout matches `general.local_model_request_timeout_seconds`.

## Privacy classifications

Sensitive tasks must not go to providers whose registry entries disallow sensitive code. Local-only work must remain on approved local models. Configuration cannot replace review of current provider data policies.

## Runtime state

Generated state is ignored by Git:

- `.opencode/agent-loop-state/`
- `.opencode/agent-loop-logs/`
- role-pool health state files

Do not commit these files or share them without reviewing them for sensitive material.

## Validation

```bash
npm ci
npm run validate
npm run validate:portable
```

The portable command runs Node-based checks on Linux, macOS, and Windows. Full validation additionally runs Bash permission checks.
