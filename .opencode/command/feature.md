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

## Required execution pattern

Create one stable `taskId` after approval and reuse it for every `agent_loop` call. Do not use the built-in `task` tool, because it bypasses routing, failover, and budget enforcement.

All delegated roles run sequentially in the shared working tree. Do not parallelize workers until isolated worktrees and deterministic reconciliation are implemented.

## Workflow

1. **PLANNING** — Read `AGENTS.md`, inspect repository status and affected code, discover validation commands, define acceptance criteria, and produce a concise plan.
2. **AWAITING_APPROVAL** — Present the plan and wait for explicit approval.
3. **BASELINE_TESTING** — Create the stable task ID and delegate a pre-change test pass. Record current failures and the behavior the implementation must change.
4. **SMOKE_TESTING** — Test the relevant free model pool and retain responsive model IDs.
5. **IMPLEMENTING** — Delegate one build role at a time. Do not edit code yourself.
6. **VERIFYING** — Delegate the test role and compare results with the baseline.
7. **STAGING_FOR_REVIEW** — Stage only intended implementation, test, and documentation files with explicit pathspecs. Verify the staged file list and `git diff --cached --check`.
8. **REVIEWING** — Delegate the independent read-only reviewer against the current staged candidate. Empty, incomplete, or unrelated staged changes are `BLOCKED`, never `PASS`.
9. **FIXING** — Combine findings into one bounded build request. After each fix, rerun tests, restage the complete candidate, and rerun review. Maximum two fix cycles.
10. **ESCALATING** — Escalate only non-budget blockers and retain the same task ID.
11. **READY_TO_COMMIT** — Confirm the exact staged candidate received final test and review PASS, contains no secrets or unrelated files, and has not changed since review.
12. **COMPLETED** — Create one focused local commit, account for test-owned background processes, and produce the final evidence and budget report.

## Hard rules

- Test before and after implementation.
- Never allow the builder to approve its own implementation.
- Never commit unless tests and independent review pass on the current staged candidate.
- Never push without asking the user first.
- Never mix pre-existing staged changes into the feature review or commit.
- Never use `git add .` or `git add -A` when unrelated changes exist.
- One active delegated role at a time.
- The orchestrator does not write code; delegate implementation.
- After every fix cycle, rerun VERIFYING, STAGING_FOR_REVIEW, and REVIEWING.
- `BUDGET_EXCEEDED` is terminal. Do not retry, escalate, or generate a replacement task ID.

See `agents/orchestrator.md` for the complete execution contract.
