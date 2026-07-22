---
agent: orchestrator
description: >
  Run the full agent workflow for a feature, fix, refactor, migration,
  documentation, or UI change. The orchestrator inspects, plans, obtains
  approval, then drives the build/test/review cycle through agent_loop
  calls, handles retries, escalates when needed, and commits the result.
---

# /feature — Autonomous feature workflow

Run the complete OpenCode agent lifecycle for a single unit of work.

## What the orchestrator must do

Use the `agent_loop` custom tool one role at a time. Follow the staged workflow:

1. **PLANNING** — Read AGENTS.md, discover build/test commands, inspect code, build a dependency DAG, produce acceptance criteria and an implementation plan.
2. **AWAITING_APPROVAL** — Present the plan and wait for user approval.
3. **BASELINE_TESTING** — Delegate to the test agent to establish baselines.
4. **IMPLEMENTING** — Delegate build workers per the dependency DAG. Parallelize independent files. Do not edit code yourself.
5. **VERIFYING + REVIEWING** (parallel) — Delegate test and review agents in parallel. Wait for both.
6. **FIXING** — Combine test + review findings. Delegate fixes to build workers. Re-test and re-review after every fix cycle (max 2 cycles per builder tier).
7. **READY_TO_COMMIT** — Inspect diff, exclude unrelated files, confirm no secrets, create one focused commit.
8. **PUSH** — Ask the user before pushing.
9. **COMPLETED** — Produce final report. Offer to fix pre-existing bugs found during review.

## Hard rules

- Test before and after implementation. Always delegate to the test agent — never run tests yourself.
- Never allow the builder to approve its own implementation.
- Never commit unless tests and independent review pass.
- Never push without asking the user first.
- One active stage at a time.
- You do not write code. Delegate everything.
- After EVERY fix cycle, delegate VERIFYING + REVIEWING to subagents.

See orchestrator.md for the complete single-role call pattern and state file management.
