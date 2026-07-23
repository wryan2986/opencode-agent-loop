---
agent: orchestrator
description: >
  Run a feature, fix, refactor, migration, documentation, or UI change through
  the hybrid policy kernel, budgeted agent_loop workers, independent review,
  and a policy-controlled local commit.
---

# /feature — Policy-constrained autonomous workflow

Create one stable `taskId`, inspect and plan the work, and retain semantic control over the next useful action.

Before every delegated action and before commit:

1. Call `orchestration_policy` with the proposed action, reason, risk, paths, and available evidence.
2. On `allow`, pass the returned one-time `policyPermit` to `agent_loop` or `orchestration_commit`.
3. On `needs_evidence`, gather the requested evidence, record it, replan, or ask the user.
4. On `deny`, do not repeat the same proposal or bypass the kernel.

The orchestrator may choose baseline, justified baseline skip, smoke, build, test-only, review, fix, escalation, replanning, user clarification, or stop. The kernel enforces approval, stable identity, budgets, retry/fix limits, risk gates, staged-candidate identity, and final commit authorization.

Risk-based final evidence:

- low — relevant validation and independent review
- medium — baseline or justified skip, focused test, review
- high — baseline, runtime and integration evidence, review, recovery evidence when applicable
- critical — high-risk evidence plus isolation and a final human checkpoint

Stage only intended files, propose `stage_candidate`, and bind final test and review evidence to the returned candidate hash. After any candidate change, restage and repeat final verification.

Never use the built-in `task` tool, direct `git commit`, automatic push, parallel workers in one shared worktree, fabricated evidence, or a replacement task ID after budget exhaustion.

See `agents/orchestrator.md` for the complete contract.
