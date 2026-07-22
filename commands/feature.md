---
agent: orchestrator
description: >
  Run the full agent workflow for a feature, fix, refactor, migration,
  documentation, or UI change. The orchestrator inspects, plans, obtains
  approval, then drives baseline, smoke, build, test, review, and escalation
  through budget-enforced agent_loop calls before creating a local commit.
---

# /feature — Autonomous feature workflow

Run the complete OpenCode agent lifecycle for a single unit of work.

## Usage

```text
/feature <description of work>
```

## Required execution pattern

The orchestrator must create one stable `taskId` after approval and reuse it for every `agent_loop` call in this feature. This makes token, cost, and workflow-call limits cumulative across stages and failover attempts.

Example:

```text
feature-auth-refresh-20260722T210000Z
```

The orchestrator must not use the built-in `task` tool for delegated work because that bypasses the agent-loop router and budget ledger.

All delegated roles run sequentially in the shared working tree. Do not parallelize workers until isolated worktrees and deterministic reconciliation are implemented.

## Workflow

1. **Read project instructions** — inspect `AGENTS.md` and repository-specific guidance.
2. **Inspect** — read affected code, repository status, and relevant configuration. Stop for user direction when unrelated staged changes already exist.
3. **Discover validation commands** — identify build, test, lint, type-check, and documentation checks.
4. **Plan** — produce explicit acceptance criteria and a concise implementation plan.
5. **Obtain approval** — wait for explicit user approval.
6. **Create the stable task ID** — retain it for the entire feature.
7. **Baseline test** — call `agent_loop` with `mode: "test"` to record pre-change behavior, current failures, and validation commands. A reproduced target bug may be an expected baseline failure; ambiguous failures block implementation.
8. **Smoke test** — call `agent_loop` with `mode: "smoke"` and the stable `taskId`; save responsive model IDs.
9. **Build** — call `agent_loop` with `mode: "build"`, the same `taskId`, and responsive model IDs.
10. **Test** — call `agent_loop` with `mode: "test"` and the same `taskId`; compare results with the baseline.
11. **Stage the review candidate** — stage only intended implementation, test, and documentation files with explicit pathspecs. Verify `git diff --cached --name-only` and `git diff --cached --check`.
12. **Review** — call `agent_loop` with `mode: "review"` and the same `taskId`. Provide acceptance criteria, baseline/test evidence, and the intended staged-file list. An empty or incomplete staged candidate is `BLOCKED`, never `PASS`.
13. **Fix** — combine findings into a bounded build request, rerun test, restage the complete candidate, and rerun review with the same ID. Maximum two fix cycles.
14. **Escalate** — use `mode: "escalate"` only for non-budget blockers and retain the same ID.
15. **Commit and clean up** — commit only the exact candidate that received final test and review PASS. Stop or explicitly account for test-owned background processes.
16. **Report** — include baseline, test and review evidence, commit hash, changed files, cleanup status, and the budget snapshot.

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
- Never mix pre-existing staged changes into the feature review or commit.
- Never use `git add .` or `git add -A` when unrelated changes exist.
- Never push automatically.
- Never rewrite history or run destructive cleanup commands.
- Only the orchestrator may create the final commit.
- See `agents/orchestrator.md` for the complete execution contract.
