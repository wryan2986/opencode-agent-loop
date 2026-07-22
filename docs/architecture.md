# Architecture

## Overview

OpenCode Agent Loop coordinates a gated development lifecycle:

`plan → approve → smoke → build → test → review → fix or escalate → commit`

The paid parent orchestrator handles inspection, planning, approval, stage order, and the final commit. Every delegated model call goes through `agent_loop`, which centralizes provider adapters, free-first routing, retries, failover, budget enforcement, and structured events.

```text
              User request
                   |
                   v
+--------------------------------------+
| Parent orchestrator                  |
| Plans and reuses one stable task ID  |
| Turn cap + workflow-call budget      |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| agent_loop runtime                   |
| Smoke | Build | Test | Review        |
| Retry | Failover | Escalate          |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Reliability services                 |
| Provider adapters | Persistent budget|
| Structured events | Checkpoints      |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| OpenCode worker processes            |
| Free/local pools -> paid fallback    |
+--------------------------------------+
```

## Workflow contract

A feature uses one stable task ID across every stage. `BUDGET_EXCEEDED` is terminal: the orchestrator must not continue under a replacement ID or bypass `agent_loop` with direct task delegation.

Test and review are independent gates. Every fix cycle returns through both. Only the parent orchestrator may create the final local commit, and it never pushes automatically.

## Agent roles

The exact number of roles may change. Current capabilities include orchestration, standard and trivial building, testing, independent review, exploration, reconciliation, escalation, and local private or low-cost work. See [Agent Roles](agent-roles.md).

## Routing and retries

Provider adapters identify models, select timeout keys, and normalize provider errors. Transient failures can retry the same model using exponential backoff and jitter. After retries are exhausted, failover moves to another eligible provider. Non-retryable task, auth, billing, safety, cancellation, and budget failures stop immediately.

Free-first worker pools may include local models and controlled paid fallback. GPT-5.6 Luna is reserved for explicit escalation.

## Budgets

Budget state is persisted atomically per project under `.opencode/agent-loop-state/`. The ledger covers delegated tokens and cost plus the number of parent workflow calls. The parent orchestrator also has a bounded turn count.

OpenCode does not currently expose parent-session token and cost events to this plugin, so snapshots state `parentModelUsageIncluded: false`. They must not be described as complete end-to-end dollar totals.

## Structured events

The runtime emits versioned JSON Lines events for workflow calls, stages, attempts, retries, model selection, cooldowns, budget changes, and completion. Events are recursively redacted and queryable with `scripts/query-events.mjs`. See [Structured Event Logging](event-logging.md).

## State and recovery

Stable configuration lives in:

- `config/free-first-config.json`
- `config/free-first-config-schema.json`
- `config/free-first-pools.json`
- `config/model-registry.json`

Ignored runtime state includes:

- persistent budgets
- structured events
- provider cooldowns
- portable task checkpoints
- attempt and progress logs

The v0.2 foundations make interrupted-state reconstruction possible; full automatic stage resume remains planned for v0.3.

## Compatibility and trust boundaries

The portable Node runtime is tested on Linux, macOS, and Windows. Bash installation and permission validation require Linux, WSL, macOS, or Git Bash. A scheduled workflow builds the patched OpenCode revision and verifies required source contracts.

Agent permissions and redaction reduce risk but are not an operating-system sandbox. Run untrusted repositories in a container or VM, keep credentials out of prompts, and review provider data policies.
