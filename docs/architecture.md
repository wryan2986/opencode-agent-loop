# Architecture

## Overview

OpenCode Agent Loop coordinates specialized agents through a gated software-development lifecycle:

`plan → approve → baseline test → implement → verify and review → fix or escalate → commit`

The parent orchestrator remains responsible for inspection, planning, approval, stage order, and the final commit. Delegated model execution is centralized in the `agent_loop` custom tool so routing, failover, paid-fallback controls, and worker-budget enforcement cannot be bypassed.

```text
              User request
                   |
                   v
+--------------------------------------+
| Parent orchestrator                  |
| Inspects, plans, requests approval   |
| Reuses one stable feature task ID    |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| agent_loop custom tool               |
| Smoke | Build | Test | Review        |
| Escalate | Failover | Budget guard   |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Specialized worker processes         |
| Free-first pools and paid fallback   |
+--------------------------------------+
```

## Workflow state machine

The normal path is:

1. **PLANNING** — inspect the repository, discover commands, and define acceptance criteria
2. **AWAITING_APPROVAL** — present the plan and wait for explicit approval
3. **SMOKE_TESTING** — identify responsive worker models through `agent_loop`
4. **IMPLEMENTING** — run the approved build request with the stable task ID
5. **VERIFYING** — run post-change verification through the test role
6. **REVIEWING** — independently inspect the diff, tests, security, and acceptance criteria
7. **READY_TO_COMMIT** — confirm gates, inspect staged content, and create a focused commit
8. **COMPLETED** — report results and budget scope

Conditional states are:

- **FIXING** — a bounded build call corrects failed test or review findings, then returns to verification and review
- **ESCALATING** — a stronger diagnostic role investigates repeated non-budget failures
- **BLOCKED** — progress requires user input, an unavailable dependency, or an exhausted budget

`BUDGET_EXCEEDED` is terminal. The orchestrator must not continue under a fresh task ID or fall back to direct task delegation.

## Agent roles

The repository contains cloud and local roles. The exact number may change as agents are added or retired, so documentation describes capabilities rather than relying on a fixed count.

| Role | Responsibility | Typical access |
|------|----------------|----------------|
| Orchestrator | Inspection, planning, stage enforcement, final commit | Read, `agent_loop`, limited Git |
| Build worker | Approved implementation | Read, edit, bounded shell |
| Trivial builder | Small bounded changes | Read, edit, bounded shell |
| Test agent | Baseline and post-change verification | Read, test edits, bounded shell |
| Review agent | Independent review | Read-only |
| Explore agent | Codebase research | Read-only |
| Reconcile agent | Integrate overlapping work | Read, edit, bounded Git |
| Escalation agent | Diagnose repeated failures | Read, edit, optionally web |
| Local agents | Sensitive, offline, or low-cost bounded work | Role-specific, local model only |

See [Agent Roles](agent-roles.md).

## Model routing

The default design uses two routing policies:

- **Parent orchestrator:** paid DeepSeek V4 Flash for dependable coordination
- **Delegated workers:** free-first ordered pools, local models where appropriate, then controlled paid fallback

GPT-5.6 Luna is reserved for explicit escalation and difficult diagnosis rather than routine work.

Provider failures are classified before failover. Rate limits and transient availability failures may trigger provider-wide cooldowns; isolated request, safety, or billing failures should only affect the relevant model or credential path.

## Runtime architecture

```text
OpenCode TUI
  |
  +-- /feature --> orchestrator
                       |
                 stable taskId
                       |
                       v
                 agent_loop tool
                       |
                       v
             agent-loop-controller.mjs
                       |
            +----------+----------+
            |          |          |
         failover   paid guard   budget guard
            |          |          |
            +----------+----------+
                       |
                       v
              OpenCode worker process
```

The plugin entry point is `.opencode/plugins/agent-loop.js`. Runtime execution is centralized under `runtime/`, with routing and budget helpers under `lib/`.

The budget ledger covers delegated worker processes. The parent orchestrator model's own message usage is outside that ledger and must be reported separately as an untracked scope limitation.

## Configuration and state

Stable configuration:

- `config/free-first-config.json`
- `config/free-first-config-schema.json`
- `config/free-first-pools.json`
- `config/model-registry.json`

Transient health data, cooldowns, failure counts, task checkpoints, and worker logs should be written to ignored runtime-state files rather than committed configuration. Budget ledgers are retained in memory only for the configured TTL and maximum task count.

See [Configuration](configuration.md).

## Trust boundaries

Agent permissions reduce accidental damage but are not an operating-system sandbox. Shell permissions must use explicit command patterns and deny destructive Git operations. Run untrusted work in a container or VM and review provider data policies before sending confidential code.

See [Safety Model](safety-model.md).