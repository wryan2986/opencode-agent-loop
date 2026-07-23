---
agent: orchestrator
description: >
  Run a feature, fix, refactor, migration, documentation, or UI change through
  the hybrid policy kernel, budgeted agent_loop workers, independent review,
  and a policy-controlled local commit.
---

# /feature — Policy-constrained autonomous workflow

Run one unit of development work while preserving the orchestration model's judgment about planning, decomposition, validation strategy, and replanning.

## Required operating pattern

1. Create one stable `taskId` at the beginning and reuse it for every policy and worker call.
2. Use `orchestration_policy` to propose each next action.
3. Read the decision:
   - `allow` — proceed and use the returned one-time permit when present.
   - `needs_evidence` — gather or record the requested evidence, or choose another legitimate action.
   - `deny` — stop, replan, ask the user, or choose a different permitted action.
4. Use `agent_loop` only with a matching `policyPermit`.
5. Use `orchestration_commit` for the final local commit. Never run `git commit` directly.
6. Never use the built-in `task` tool for delegated work.

The configured kernel mode is recorded in every decision:

- `shadow` observes without blocking.
- `invariants` enforces non-negotiable safeguards and reports risk gates as advisory.
- `risk` enforces safeguards and risk-based minimum evidence. This is the default.

## Flexible action loop

The workflow is not a mandatory linear pipeline. The orchestrator may propose:

- inspection, replanning, asking the user, or stopping
- approval recording
- baseline testing or a justified baseline skip
- smoke testing
- build, test-only, review-only, fix, or escalation work
- staged-candidate registration
- semantic evidence such as integration coverage, recovery plans, isolation, or human checkpoints
- final commit authorization

The kernel may elevate risk based on task text or actual staged paths, but it never lowers the orchestrator's proposed risk.

Minimum final evidence generally scales as follows:

- low: relevant validation and independent review
- medium: baseline or justified skip, focused test, independent review
- high: baseline, runtime test, representative integration evidence, review, and recovery evidence when applicable
- critical: high-risk evidence plus isolation and a final human checkpoint

## Candidate integrity

Stage only intended files with explicit pathspecs, then propose `stage_candidate`. The kernel hashes the staged diff. Final test and review results are bound to that hash, and the commit tool refuses to commit if the staged candidate changes after authorization.

After any fix or test-generated file change:

1. restage the complete intended candidate
2. propose `stage_candidate` again
3. rerun final test and review against the new hash

## Hard rules

- Wait for explicit approval before implementation.
- Preserve unrelated working-tree and staged changes.
- Never parallelize delegated roles in one shared working tree.
- Never fabricate evidence or repeatedly argue with a denial.
- `BUDGET_EXCEEDED` is terminal for delegated work.
- Never push, merge, rewrite history, or run destructive cleanup automatically.

See `agents/orchestrator.md` for the complete action, evidence, permit, and risk contract.
