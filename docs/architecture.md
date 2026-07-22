# Architecture

## Overview

The OpenCode Agent Loop is a framework for autonomous software-development task orchestration. It coordinates specialized AI agents across a structured lifecycle: plan → approve → test → implement → verify → review → fix → commit.

```
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator Agent                                      │
│ Reads AGENTS.md → Inspects code → Plans → Delegates     │
│ Enforces stage order, manages failover, creates commit   │
└──────┬──────┬──────┬──────┬──────┬──────┬──────┬────────┘
       │    │    │    │    │    │    │
       ▼    ▼    ▼    ▼    ▼    ▼    ▼
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌─────────┐
│Test│ │Build│ │Review│ │Esc │ │Rec │ │Explore │ │Trivial │
│    │ │    │ │      │ │    │ │    │ │        │ │         │
└────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └─────────┘
```

## Workflow Stages

The orchestrator enforces a state machine with 9 stages:

1. **PLANNING** — Inspects repository, discovers commands, builds dependency DAG
2. **AWAITING_APPROVAL** — Presents plan, waits for user approval
3. **BASELINE_TESTING** — Establishes pre-implementation test baseline
4. **IMPLEMENTING** — Delegates to build workers (parallel per DAG level)
5. **VERIFYING** — Delegates to test agent for post-implementation verification
6. **REVIEWING** — Delegates to review agent for independent code review
7. **FIXING** — Combines test+review findings, delegates fixes (max 2 cycles/tier)
8. **READY_TO_COMMIT** — Validates diff, creates commit
9. **ESCALATING** — GPT-5.6 Luna diagnosis for stalled tasks

## Agent Roles

| Agent | Responsibility | Tools |
|-------|---------------|-------|
| Orchestrator | Planning, delegation, stage enforcement, commit | read, task, question |
| Build worker | Implementation following ACs | read, write, edit, bash |
| Test agent | Baseline, verification, regression tests | read, edit, bash |
| Review agent | Independent code review, diff inspection | read (read-only) |
| Escalation | Stalled task diagnosis and recovery | read, edit, webfetch |
| Reconcile | Conflict resolution for overlapping changes | read, edit, git merge |
| Explore | Codebase exploration and research | read (read-only) |
| Trivial builder | Fast small-bounded changes | read, edit, bash |

## Model Routing

The system uses paid-primary routing with automatic failover:

1. Primary paid model configured per role
2. On failure (rate limit, timeout): try free fallback from different provider
3. On repeated failure: try local Ollama 9B model
4. On all failures: escalate to diagnosis agent

See docs/providers.md for model configuration details.

## Runtime Architecture

```
OpenCode TUI │
  ├── /feature command → orchestrator agent │
  │     │ │
  │     └── task() tool calls for subagents │
  └── /loop command → agent_loop custom tool │
        └── runtime/agent-loop-controller.mjs │
              └── runtime/execute-agent-task.mjs │
                    ├── lib/failover-handler.mjs │
                    ├── lib/paid-fallback.mjs │
                    ├── lib/smoke-test.mjs │
                    └── runtime/opencode-worker-runner.mjs │
                          └── opencode run --agent <role> --model <model>
```

## Configuration

Three config files control behavior:
- **free-first-config.json** — Global settings (failover, cooldowns, privacy, retry)
- **free-first-pools.json** — Role-based model pools with ordered failover
- **model-registry.json** — Capability scores, privacy classification, pricing

See docs/configuration.md for detailed configuration reference.