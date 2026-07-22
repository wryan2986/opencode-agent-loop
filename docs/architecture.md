# Architecture

## Overview

OpenCode Agent Loop coordinates specialized agents through a gated software-development lifecycle:

`plan → approve → baseline test → implement → verify and review → fix or escalate → commit`

The orchestrator remains responsible for planning, delegation, state transitions, failover decisions, and the final commit. Implementation, testing, and review are delegated to separate roles.

```text
              User request
                   |
                   v
+--------------------------------------+
| Orchestrator                         |
| Inspects, plans, delegates           |
| Enforces stages and creates commit   |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Specialized roles                    |
| Build | Test | Review | Explore      |
| Reconcile | Escalate | Local agents  |
+--------------------------------------+
                   |
                   v
+--------------------------------------+
| Routing and runtime                  |
| Pools | Registry | Failover | State  |
+--------------------------------------+
```

## Workflow state machine

The normal path is:

1. **PLANNING** — inspect the repository, discover commands, define acceptance criteria, and build a dependency DAG
2. **AWAITING_APPROVAL** — present the plan and wait for explicit approval
3. **BASELINE_TESTING** — delegate baseline verification to the test agent
4. **IMPLEMENTING** — delegate approved work to builders by dependency level
5. **VERIFYING** — run post-change verification through the test agent
6. **REVIEWING** — independently inspect the diff, tests, security, and acceptance criteria
7. **READY_TO_COMMIT** — confirm gates, inspect staged content, and create a focused commit
8. **COMPLETED** — report results and remove transient state

Conditional states are:

- **FIXING** — builder corrects failed test or review findings, then returns to verification and review
- **ESCALATING** — a stronger diagnostic agent investigates repeated failures, then returns to baseline testing or implementation as appropriate
- **RECONCILING** — overlapping parallel changes are integrated, then returned to verification
- **BLOCKED** — progress requires user input or an unavailable dependency

The orchestrator must not skip baseline testing, independent verification, or review.

## Agent roles

The repository contains cloud and local roles. The exact number may change as agents are added or retired, so documentation describes capabilities rather than relying on a fixed count.

| Role | Responsibility | Typical access |
|------|----------------|----------------|
| Orchestrator | Planning, delegation, state enforcement, final commit | Read, task, limited Git |
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

- **Orchestrator:** paid DeepSeek V4 Flash for dependable coordination
- **Delegated roles:** free-first ordered pools, local models where appropriate, then controlled paid fallback

GPT-5.6 Luna is reserved for explicit escalation and difficult diagnosis rather than routine work.

Provider failures are classified before failover. Rate limits and transient availability failures may trigger provider-wide cooldowns; isolated request, safety, or billing failures should only affect the relevant model or credential path.

## Runtime architecture

```text
OpenCode TUI
  |
  +-- /feature --> orchestrator --> task() subagents
  |
  +-- /loop ----> agent_loop plugin
                     |
                     v
            agent-loop-controller.mjs
                     |
          +----------+----------+
          |          |          |
       failover   paid guard   smoke test
          |          |          |
          +----------+----------+
                     |
                     v
            OpenCode worker process
```

The plugin entry point is `.opencode/plugins/agent-loop.js`. Runtime execution is centralized under `runtime/`, with routing helpers under `lib/`.

## Configuration and state

Stable configuration:

- `config/free-first-config.json`
- `config/free-first-pools.json`
- `config/model-registry.json`

Transient health data, cooldowns, failure counts, and task checkpoints should be written to ignored runtime-state files rather than committed configuration.

See [Configuration](configuration.md).

## Trust boundaries

Agent permissions reduce accidental damage but are not an operating-system sandbox. Shell permissions must use explicit command patterns and deny destructive Git operations. Run untrusted work in a container or VM and review provider data policies before sending confidential code.

See [Safety Model](safety-model.md).
