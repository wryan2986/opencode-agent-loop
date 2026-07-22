---
agent: orchestrator
description: >
  Run the full agent workflow for a feature, fix, refactor, migration,
  documentation, or UI change. The orchestrator inspects, plans, obtains
  approval, then drives smoke, build, test, review, and escalation through
  budget-enforced agent_loop calls before creating a local commit.
---

# /feature — Autonomous feature workflow

Run the complete OpenCode agent lifecycle for a single unit of work.

## Usage

```text
/feature <description of work>
```

## Required execution pattern

The orchestrator must create one stable `taskId` at the beginning and reuse it for every `agent_loop` call in this feature. This is what makes token and cost limits cumulative across stages and failover attempts.

Example:

```text
feature-auth-refresh-20260722T210000Z
```

The orchestrator must not use the built-in `task` tool for delegated work because that bypasses the agent-loop router and budget ledger.

## Workflow

1. **Read project instructions** — inspect `AGENTS.md` and repository-specific guidance.
2. **Inspect** — read affected code, repository status, and relevant configuration.
3. **Discover validation commands** — identify build, test, lint, type-check, and documentation checks.
4. **Plan** — produce explicit acceptance criteria and a concise implementation plan.
5. **Obtain approval** — wait for explicit user approval.
6. **Create the stable task ID** — retain it for the entire feature.
7. **Smoke test** — call `agent_loop` with `mode: "smoke"` and the stable `taskId`; save responsive model IDs.
8. **Build** — call `agent_loop` with `mode: "build"`, the same `taskId`, and responsive model IDs.
9. **Test** — call `agent_loop` with `mode: "test"` and the same `taskId`.
10. **Review** — call `agent_loop` with `mode: "review"` and the same `taskId`.
11. **Fix** — combine findings into a bounded build request, then rerun test and review with the same ID. Maximum two fix cycles.
12. **Escalate** — use `mode: "escalate"` only for non-budget blockers and retain the same ID.
13. **Commit** — only after final PASS from both test and review.
14. **Report** — include evidence, commit hash, changed files, and the budget snapshot.

## Budget exhaustion

`code: "BUDGET_EXCEEDED"` is terminal for the feature request.

When it occurs:

- stop all retries and escalation
- do not generate a replacement task ID
- do not bypass the limit with direct task delegation
- report limits, usage, cost, exceeded reasons, and the per-step/per-model breakdown

The budget covers delegated worker calls made through `agent_loop`. It does not include the parent orchestrator model's own conversation usage.

## Hard rules

- Reject an empty task with: "Please describe the work to be done."
- Preserve unrelated working-tree changes.
- Never push automatically.
- Never rewrite history or run destructive cleanup commands.
- Only the orchestrator may create the final commit.
- See `agents/orchestrator.md` for the complete execution contract.