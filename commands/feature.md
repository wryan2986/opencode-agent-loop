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

## Usage

```
/feature <description of work>
```

## What the orchestrator must do

Use the `agent_loop` custom tool one role at a time. Each call returns independently so the user sees progress.

1. **Read AGENTS.md** — check the project's AGENTS.md for project-specific instructions.
2. **Inspect** — read the affected code, discover build/test commands, understand the architecture.
3. **Assess server lifecycle tooling** — if the project needs a server for testing, create or verify `scripts/start-for-testing.sh` and `scripts/stop-server.sh`.
4. **Plan** — produce explicit acceptance criteria and a concise implementation plan.
5. **Obtain approval** — present the plan and wait for user approval.
6. **Smoke test** — call `agent_loop` with `mode: "smoke"` to test model responsiveness. Save responsive model IDs.
7. **Delegate build** — call `agent_loop` with `mode: "build"` + `models` from smoke results.
8. **Delegate test** — call `agent_loop` with `mode: "test"` + `models`.
9. **Delegate review** — call `agent_loop` with `mode: "review"`.
10. **Handle failures** — if build fails, retry once. If still fails, call `mode: "escalate"`.
11. **Commit** — only after final PASS from both test and review.
12. **Offer cleanup pass** — present pre-existing bugs found during review and ask if user wants them fixed.

## Hard rules

- Reject an empty task with a clear message: "Please describe the work to be done."
- Preserve unrelated working-tree changes (do not discard them).
- Never push automatically.
- Only the orchestrator may create the final commit.
- See orchestrator.md for the complete single-role call pattern.
