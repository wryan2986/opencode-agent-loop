# Architecture

## Overview

OpenCode Agent Loop uses a policy-constrained action graph rather than one universal fixed pipeline.

> **The model proposes; the kernel validates; an authorized tool executes.**

The paid parent orchestrator handles semantic work: inspection, planning, decomposition, risk reasoning, validation strategy, next-action selection, replanning, and user communication. The orchestration policy kernel handles objective controls: approval records, stable task identity, budgets, one-time permits, risk minimums, staged-candidate identity, fix limits, and final commit authorization.

Every delegated model call then goes through `agent_loop`, which centralizes provider adapters, free-first routing, retries, failover, worker-budget enforcement, and structured events.

```text
                 User request
                      |
                      v
+--------------------------------------------+
| Parent orchestrator                        |
| Understands task and proposes next action  |
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Orchestration policy kernel                |
| Approval | Risk | Evidence | Permit | Hash |
+--------------------------------------------+
                      |
               one-time permit
                      |
                      v
+--------------------------------------------+
| agent_loop runtime                         |
| Retry | Route | Failover | Worker Budget   |
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Provider adapters and worker processes     |
| Free/local pools -> controlled paid use    |
+--------------------------------------------+
                      |
                      v
+--------------------------------------------+
| Persistent state and structured events     |
| Policy | Budget | Candidate | JSONL audit  |
+--------------------------------------------+
```

## Flexible reasoning and deterministic policy

The orchestration model decides:

- how to decompose and implement the request
- whether a baseline is useful
- which tests and evidence fit the repository
- whether to build, test existing behavior, review, replan, ask the user, escalate, or stop
- what semantic risk applies
- whether newly discovered work belongs in scope

The kernel decides:

- whether approval is recorded
- whether a task or budget is terminal
- whether an action is authorized
- whether a permit is valid, unused, unexpired, and mode-matched
- whether minimum evidence for the effective risk exists
- whether the staged candidate matches tested and reviewed evidence
- whether a commit can proceed without candidate drift

This keeps the kernel narrow. It verifies objective properties instead of trying to make architecture or engineering judgments.

## Policy phases

The same kernel supports three operating modes:

1. **Shadow** — record the decision the kernel would make while allowing the action.
2. **Invariants** — enforce hard safeguards while reporting risk gates as advisory.
3. **Risk** — enforce safeguards and low/medium/high/critical minimum evidence.

The default is `risk`. See [Hybrid Orchestration Policy](orchestration-policy.md).

## Action and permit contract

A typical delegated action is:

1. The orchestrator proposes an action to `orchestration_policy`.
2. The kernel returns `allow`, `needs_evidence`, or `deny`.
3. An allowed delegated action receives a one-time permit bound to the task, action, and runtime mode.
4. `agent_loop` consumes the permit before launching a worker.
5. The worker result is stored as runtime evidence.

The action graph includes inspection, approval, baseline or justified skip, smoke, build, test, staging, review, fix, escalation, replanning, user clarification, commit, and stop. The model chooses among legal actions; the kernel does not force every task through every node.

## Candidate identity

`stage_candidate` computes a SHA-256 digest of the staged binary diff and records its files. Final test and review permits capture that digest. A changed candidate invalidates earlier final evidence.

The final local commit is made through `orchestration_commit`, not direct Git. The commit tool consumes a one-time commit permit, recalculates the staged digest, and fails with `POLICY_CANDIDATE_CHANGED` when anything changed after authorization.

## Risk gates

The model proposes risk and explains why. The kernel examines task text, planned paths, and actual staged paths. It can elevate risk but never lower the model's proposal.

Default minimum final evidence:

| Risk | Minimum evidence |
|---|---|
| Low | Relevant validation or test and independent review |
| Medium | Baseline or justified skip, focused test, review |
| High | Baseline, runtime test, representative integration evidence, review, recovery evidence when applicable |
| Critical | High-risk evidence plus isolation and a final human checkpoint |

The model still chooses the specific tests, integration scenarios, recovery approach, and implementation design.

## Agent roles

The exact number of roles may change. Current capabilities include orchestration, standard and trivial building, testing, independent review, exploration, reconciliation, escalation, and local private or low-cost work. See [Agent Roles](agent-roles.md).

## Routing and retries

Provider adapters identify models, select timeout keys, and normalize provider errors. Transient failures can retry the same model using exponential backoff and jitter. After retries are exhausted, failover moves to another eligible provider. Non-retryable task, auth, billing, safety, cancellation, policy, and budget failures stop or require a newly authorized action.

Free-first worker pools may include local models and controlled paid fallback. GPT-5.6 Luna is reserved for explicit escalation.

## Budgets

Budget state is persisted atomically per project under `.opencode/agent-loop-state/`. The ledger covers delegated tokens and cost plus workflow calls. The parent orchestrator also has a bounded turn count.

OpenCode does not currently expose parent-session token and cost events to this plugin, so snapshots state `parentModelUsageIncluded: false`. They must not be described as complete end-to-end dollar totals.

## Structured events

The runtime emits versioned JSON Lines events for policy proposals and decisions, permits, workflow calls, stages, attempts, retries, model selection, cooldowns, budgets, candidate state, and completion. Events are recursively redacted and queryable with `scripts/query-events.mjs`. See [Structured Event Logging](event-logging.md).

Policy events make the model/kernel interaction observable:

- action and risk proposed by the model
- risk elevation by the kernel
- enforced or shadow decision
- missing or advisory evidence
- permit issuance and consumption
- how the model adapts after feedback

## State and recovery

Stable configuration lives in:

- `config/orchestration-policy.json`
- `config/orchestration-policy-schema.json`
- `config/free-first-config.json`
- `config/free-first-config-schema.json`
- `config/free-first-pools.json`
- `config/model-registry.json`

Ignored runtime state includes:

- persistent orchestration policy state
- persistent budgets
- structured events
- provider cooldowns
- portable task checkpoints
- attempt and progress logs

The durable policy and evidence foundations make interrupted-state reconstruction possible; automatic semantic resume remains future work because the orchestrator must still evaluate whether old evidence remains applicable.

## Compatibility and trust boundaries

The portable Node runtime is tested on Linux, macOS, and Windows. Bash installation and permission validation require Linux, WSL, macOS, or Git Bash. A scheduled workflow builds the patched OpenCode revision and verifies required source contracts.

Agent permissions, policy checks, and redaction reduce risk but are not an operating-system sandbox. Run untrusted repositories in a container or VM, keep credentials out of prompts, and review provider data policies.
