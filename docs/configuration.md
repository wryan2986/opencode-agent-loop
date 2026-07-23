# Configuration

OpenCode Agent Loop separates orchestration policy, stable model metadata, role ordering, runtime policy, and generated state.

## Stable configuration

### `config/orchestration-policy.json`

Controls the hybrid model/kernel boundary:

- enforcement mode: `shadow`, `invariants`, or `risk`
- whether delegated calls require one-time permits
- whether the final commit must use `orchestration_commit`
- permit lifetime
- persistent policy-state retention
- maximum fix cycles
- path and keyword risk signals
- documented low, medium, high, and critical evidence gates

The default is `risk`, which enforces hard invariants and risk-based minimum evidence. See [Hybrid Orchestration Policy](orchestration-policy.md).

Temporary evaluation overrides:

```bash
AGENT_LOOP_POLICY_MODE=shadow opencode
AGENT_LOOP_POLICY_MODE=invariants opencode
AGENT_LOOP_POLICY_MODE=risk opencode
```

Managed deployments and tests may override the state file with `AGENT_LOOP_POLICY_STATE_PATH`. Do not use overrides to evade a repository's approved policy.

### `config/free-first-config.json`

Controls free-first and paid-fallback policy, retries, cooldowns, provider timeouts, privacy classifications, budgets, state retention, and structured event logging. Treat it as policy; never store credentials in it.

### `config/free-first-pools.json`

Defines ordered model candidates for every role. A pool normally contains free models from different providers, optional local models, and controlled paid fallbacks. Runtime cooldowns and failure counters do not belong in this committed file.

### `config/model-registry.json`

Stores stable model identity, capability, privacy, retirement, and pricing metadata.

### Configuration schemas

- `config/orchestration-policy-schema.json` defines the hybrid orchestration policy.
- `config/free-first-config-schema.json` defines the routing and runtime policy.
- `config/agent-loop-event.schema.json` defines structured events.

CI also runs semantic checks that JSON Schema alone cannot express.

## Hybrid orchestration strategy

The authority boundary is:

> The model proposes; the kernel validates; an authorized tool executes.

The orchestration model decides planning, decomposition, semantic risk, validation strategy, next action, replanning, escalation, and user communication. The kernel controls approval records, stable task identity, budgets, one-time permits, minimum risk evidence, candidate hashes, fix limits, and final commit authorization.

A delegated call follows this pattern:

1. The orchestrator proposes an action through `orchestration_policy`.
2. The kernel returns `allow`, `needs_evidence`, or `deny`.
3. An allowed delegated action includes a one-time `policyPermit`.
4. The orchestrator passes that permit to the matching `agent_loop` mode.
5. The kernel consumes the permit and records the runtime result.

Direct use of OpenCode's built-in `task` tool bypasses this package's router, budgets, evidence, and policy controls and is prohibited for feature work.

## Risk policy

The model proposes `low`, `medium`, `high`, or `critical` risk and supplies reasons and likely paths. The kernel independently examines task text, planned paths, and actual staged paths. It may elevate the effective risk level but never lower the model's proposal.

Default final gates:

| Risk | Minimum evidence |
|---|---|
| Low | Relevant validation or test plus independent review |
| Medium | Baseline or justified skip, focused runtime test, independent review |
| High | Baseline, runtime test, representative integration evidence, review, recovery evidence when applicable |
| Critical | High-risk evidence plus isolation and a final human checkpoint |

These are minimums. The model still chooses the repository-appropriate commands and implementation strategy.

## Candidate identity and commit policy

After staging intended files, the orchestrator proposes `stage_candidate`. The kernel computes a SHA-256 digest of the staged binary diff and records the file list.

Final test and review evidence is bound to that candidate. A later file change invalidates the previous evidence. The final `commit` proposal produces a one-time commit permit, and `orchestration_commit` recalculates the hash before running Git. Candidate drift fails closed with `POLICY_CANDIDATE_CHANGED`.

## Routing strategy

The default model strategy is:

- paid DeepSeek V4 Flash for the parent orchestrator
- free-first pools for delegated build, test, review, exploration, and reconciliation work
- local models for suitable low-cost or private tasks
- controlled paid fallback after suitable free/local choices fail or are unavailable
- GPT-5.6 Luna for explicit escalation and difficult diagnosis

Provider adapters normalize identity, timeout selection, and provider-specific errors. See [Provider Adapters](provider-adapters.md).

## Retry policy

`maxRetries` controls retries of the same model after transient provider or network failures. Retries use exponential backoff plus jitter and count toward the task budget. Provider failover begins only after same-model retries are exhausted.

Authentication, billing, safety, invalid-request, task-quality, cancellation, policy, and budget failures are terminal or require a new authorized action rather than blind retries.

## Task budgets

One stable task ID shares a ledger across baseline, smoke, build, test, review, fixes, escalation, and provider failover.

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

Paid fallback selections and call counters are persisted per project under `.opencode/agent-loop-state/`. The audit log contains only model, role, failure-code, and outcome metadata; it excludes prompts and credentials. Persistence prevents a process restart from resetting paid-call ceilings.

The global call limit uses a rolling window controlled by `paid_fallback_global_window_minutes`—24 hours by default—rather than becoming a permanent lifetime lockout. Per-task counters are pruned after `paid_fallback_task_state_ttl_minutes`, also 24 hours by default.

## Structured events

The default append-only stream is:

```text
<project>/.opencode/agent-loop-state/events.jsonl
```

Events conform to `config/agent-loop-event.schema.json` and cover policy proposals and decisions, permits, stages, model attempts, retries, provider cooldowns, budget updates, candidate state, and completion. See [Structured Event Logging](event-logging.md).

Policy state is stored separately at:

```text
<project>/.opencode/agent-loop-state/policy.json
```

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
